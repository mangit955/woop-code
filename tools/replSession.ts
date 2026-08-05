/**
 * A live interpreter that outlasts a single tool call.
 *
 * The problem this exists for is measurable. Across the recorded benchmark
 * trials the agent made 1,017 inline `python3 -c` / `node -e` calls, and every
 * one of them started from nothing: in the video-processing trial 74 scripts
 * opened the same MP4 63 times, re-decoding it each call because there was
 * nowhere to keep the decoded frames. `gates.txt` was re-parsed 26 times,
 * `input.tex` 35 times. That is paid twice — once in wall clock and iterations,
 * and once in tokens, because every one of those script bodies stays in the
 * conversation for the rest of the run.
 *
 * Kept apart from `repl.ts` the way `textEdit.ts` is kept apart from
 * `editFile.ts`: "keep a subprocess alive and talk to it" is a question about
 * processes, not about tools, and it is the part worth testing on its own.
 *
 * ## Why a driver and not `python3 -i`
 *
 * An interactive interpreter is built for a terminal, not a protocol. Output
 * arrives interleaved with prompts (`>>> `, `... `), continuation state depends
 * on blank lines, and there is no marker saying a statement finished — so a
 * reader has to guess, and guesses wrongly on any code that prints something
 * prompt-shaped. Instead each interpreter runs a small driver that speaks a
 * framed protocol: one JSON-encoded string of source per line in, the captured
 * output followed by a per-session sentinel out. Nothing has to be guessed.
 *
 * The sentinel is a UUID generated per session rather than a fixed string, so
 * source that happens to print the delimiter cannot end a read early.
 */

import { randomUUID } from "node:crypto";

export type ReplLanguage = "python" | "node";

/** Characters of output kept from a single evaluation. */
export const MAX_REPL_OUTPUT = 16 * 1024;

/** How long one evaluation may run before the session is considered lost. */
export const DEFAULT_EVAL_TIMEOUT_SECONDS = 120;

/**
 * Python's side of the protocol.
 *
 * `exec` into one persistent globals dict is what makes state survive. The
 * `ast` dance around the final statement is what makes the session usable as a
 * REPL rather than as a script runner: `frames[0].shape` on its own line should
 * print, and under a plain `exec` it evaluates and discards silently, which
 * reads to the model as a tool that returned nothing.
 *
 * stdout and stderr are captured into one buffer so a traceback arrives in the
 * same result as the output that preceded it, in the order they happened.
 * `BaseException` rather than `Exception` so a `SystemExit` from library code
 * is reported instead of killing the driver and taking the session with it.
 */
const PYTHON_DRIVER = String.raw`
import sys, json, io, ast, traceback

_globals = {"__name__": "__main__"}
_sentinel = sys.argv[1]

def _run(source):
    block = ast.parse(source, "<repl>", "exec")
    if not block.body:
        return
    last = block.body[-1]
    if isinstance(last, ast.Expr):
        head = ast.Module(body=block.body[:-1], type_ignores=[])
        exec(compile(head, "<repl>", "exec"), _globals)
        value = eval(compile(ast.Expression(last.value), "<repl>", "eval"), _globals)
        if value is not None:
            print(repr(value))
    else:
        exec(compile(block, "<repl>", "exec"), _globals)

for _line in sys.stdin:
    _line = _line.strip()
    if not _line:
        continue
    _buffer = io.StringIO()
    _out, _err = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = _buffer
    try:
        _run(json.loads(_line))
    except BaseException:
        traceback.print_exc(file=_buffer)
    finally:
        sys.stdout, sys.stderr = _out, _err
    _out.write(_buffer.getvalue())
    _out.write("\n" + _sentinel + "\n")
    _out.flush()
`;

/**
 * Node's side of the same protocol.
 *
 * `runInThisContext` rather than a fresh context per call, because a fresh one
 * is what loses the state this whole file exists to keep. It also decides the
 * rule the tool description has to state: a top-level `var` becomes a property
 * of the global object and survives, while `const` and `let` are scoped to the
 * single script and do not. That is Node's semantics, not a choice made here,
 * and pretending otherwise by rewriting declarations would break any source
 * that shadows a name deliberately.
 *
 * `console` is redirected rather than the process's stdout, so that the
 * sentinel frame is written by this driver alone and cannot be interleaved
 * with evaluated output.
 */
const NODE_DRIVER = String.raw`
const vm = require("vm");
const util = require("util");
// argv[1], not [2]: with -e there is no script path, so the first trailing
// argument sits where a filename normally would. Both node and bun agree.
const sentinel = process.argv[1];

let buffer = "";
const write = (...args) => {
  buffer += args
    .map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 4 })))
    .join(" ") + "\n";
};
console.log = write;
console.error = write;
console.warn = write;
console.info = write;

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (!line.trim()) continue;
    buffer = "";
    try {
      let value = vm.runInThisContext(JSON.parse(line), { filename: "<repl>" });
      if (value && typeof value.then === "function") value = await value;
      if (value !== undefined) write(util.inspect(value, { depth: 4 }));
    } catch (error) {
      buffer += (error && error.stack) || String(error);
      buffer += "\n";
    }
    process.stdout.write(buffer + "\n" + sentinel + "\n");
  }
});
`;

interface Driver {
  /** Looked up on PATH; the first that resolves wins. */
  readonly candidates: readonly string[];
  readonly source: string;
  /** The flag that makes the interpreter read the driver from an argument. */
  readonly flag: string;
}

const DRIVERS: Record<ReplLanguage, Driver> = {
  // `-u` because the driver's framing is only useful if it is not sitting in a
  // block-buffered pipe waiting for more.
  python: { candidates: ["python3", "python"], source: PYTHON_DRIVER, flag: "-u" },
  node: { candidates: ["node", "bun"], source: NODE_DRIVER, flag: "-e" },
};

export class ReplUnavailableError extends Error {}

/**
 * All three streams piped, stated rather than inferred.
 *
 * `ReturnType<typeof Bun.spawn>` is the shape for the *default* options, where
 * stdin is ignored — so a session typed that way has a `stdin` of `number` and
 * no `write` on it, which is the opposite of what this file needs.
 */
type PipedProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

/**
 * The stream is consumed through its async iterator rather than a reader.
 *
 * Bun's `ReadableStreamDefaultReader.read` takes a buffer to fill, so the
 * zero-argument DOM form does not type-check against it. The iterator hands
 * back the chunk instead, which is all this needs, and it is still one held
 * cursor across many evaluations — the property that matters, since a reader
 * acquired per call would drop whatever had already been buffered.
 */
type StreamCursor = AsyncIterator<Uint8Array>;

interface Session {
  proc: PipedProcess;
  cursor: StreamCursor;
  sentinel: string;
  /** Output read past the last sentinel, belonging to no evaluation yet. */
  pending: string;
  /** Set when a timeout or a crash makes further evaluation meaningless. */
  broken: boolean;
}

const sessions = new Map<ReplLanguage, Session>();

function spawnSession(language: ReplLanguage): Session {
  const driver = DRIVERS[language];
  const interpreter = driver.candidates
    .map((candidate) => Bun.which(candidate))
    .find((resolved): resolved is string => resolved !== null);

  if (!interpreter) {
    throw new ReplUnavailableError(
      `No ${language} interpreter is available on this machine ` +
        `(looked for ${driver.candidates.join(", ")}). Use run_terminal instead.`,
    );
  }

  const sentinel = `__woopcode_repl_${randomUUID()}__`;
  const args =
    language === "python"
      ? [driver.flag, "-c", driver.source, sentinel]
      : [driver.flag, driver.source, sentinel];

  const proc: PipedProcess = Bun.spawn({
    cmd: [interpreter, ...args],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    proc,
    cursor: proc.stdout[Symbol.asyncIterator]() as StreamCursor,
    sentinel,
    pending: "",
    broken: false,
  };
}

/**
 * Reads until the session's sentinel arrives.
 *
 * Three ways this ends badly, and all three have to leave the session dead
 * rather than merely return an error: a timeout means the driver is still
 * evaluating and will write its output into the *next* read, a closed stream
 * means the interpreter is gone, and a cancellation means the user is no longer
 * waiting. A session left alive after any of them answers the following call
 * with the previous call's output.
 */
async function readFrame(
  session: Session,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutSeconds * 1000;

  // One timer for the whole read, not one per chunk. Created inside the loop it
  // was a fresh `Bun.sleep` on every chunk received, none of them cancelled
  // when the race was won by the stream — so reading a large result left one
  // live timer per chunk, each pending for the rest of the timeout. A single
  // promise raced repeatedly settles once and costs one timer.
  let expired = false;
  const timeout = Bun.sleep(timeoutSeconds * 1000).then(() => {
    expired = true;
    return "timeout" as const;
  });

  while (true) {
    const marker = session.pending.indexOf(session.sentinel);
    if (marker !== -1) {
      const frame = session.pending.slice(0, marker);
      session.pending = session.pending.slice(marker + session.sentinel.length);
      // Newlines only, at both ends. The driver writes a newline before the
      // sentinel and another after it, so an untrimmed frame carries the
      // previous call's trailing byte at its front. Trimming whitespace
      // generally would eat the indentation of output that begins with it.
      return frame.replace(/^\n+/, "").replace(/\n+$/, "");
    }

    if (signal?.aborted) {
      session.broken = true;
      throw new Error("Evaluation cancelled");
    }

    if (expired || Date.now() >= deadline) {
      session.broken = true;
      throw new Error(
        `Evaluation timed out after ${timeoutSeconds} seconds. The session was ` +
          `discarded, so its variables are gone; the next call starts a fresh one.`,
      );
    }

    // Raced rather than awaited outright: `cursor.next()` on a process that is
    // busy evaluating never settles, so without this the timeout above is
    // unreachable and a runaway loop hangs the turn instead of ending it.
    const chunk = await Promise.race([session.cursor.next(), timeout]);

    if (chunk === "timeout") continue;
    if (chunk.done) {
      session.broken = true;
      throw new Error(
        "The interpreter exited. Its state is gone; the next call starts a fresh one.",
      );
    }

    session.pending += decoder.decode(chunk.value as Uint8Array, { stream: true });
  }
}

/**
 * Ends one session.
 *
 * stdin is closed before the kill, and that ordering is the whole of it. Both
 * drivers loop until their input ends, so closing stdin is what lets them
 * return normally; `kill` alone left the pipe open, and Bun kept the process
 * handle alive waiting on a writer that never went away — a probe that had
 * already printed every result sat for two minutes before exiting. The kill
 * stays as the backstop for a driver wedged inside an evaluation, which will
 * never reach its read of stdin to notice the close.
 */
function discard(language: ReplLanguage): void {
  const session = sessions.get(language);
  if (!session) return;
  sessions.delete(language);

  session.cursor.return?.(undefined)?.catch(() => {
    // The process is being killed regardless; a cursor that will not release
    // is not a reason to leave the interpreter running.
  });

  try {
    session.proc.stdin.end();
  } catch {
    // Already closed, or the process is gone. The kill below covers both.
  }

  session.proc.kill();
  session.proc.unref();
}

export interface EvalOptions {
  restart?: boolean;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

export interface EvalResult {
  output: string;
  /** True when this call started the interpreter rather than reusing it. */
  started: boolean;
}

export async function evaluate(
  language: ReplLanguage,
  code: string,
  options: EvalOptions = {},
): Promise<EvalResult> {
  const { restart = false, timeoutSeconds = DEFAULT_EVAL_TIMEOUT_SECONDS, signal } = options;

  if (restart) discard(language);

  const existing = sessions.get(language);
  // A broken session is replaced rather than reported: the model asked for an
  // evaluation, and the fact that the previous one timed out has already been
  // reported to it as that call's error.
  if (existing?.broken) discard(language);

  let session = sessions.get(language);
  const started = session === undefined;
  if (!session) {
    session = spawnSession(language);
    sessions.set(language, session);
  }

  // One line, so the driver's line-oriented read frames it. JSON.stringify is
  // what makes that safe for source containing newlines, quotes or backslashes.
  session.proc.stdin.write(`${JSON.stringify(code)}\n`);
  session.proc.stdin.flush();

  try {
    const output = await readFrame(session, timeoutSeconds, signal);
    return { output, started };
  } catch (error) {
    discard(language);
    throw error;
  }
}

/**
 * Ends every session.
 *
 * Called from the agent loop's `finally`, which is the only place that runs on
 * all of a turn's exits. Per-turn scope is deliberate: an interpreter that
 * outlived its turn would answer the next one with variables nobody in that
 * conversation set, and the model has no way to see that history exists.
 */
export function closeReplSessions(): void {
  for (const language of [...sessions.keys()]) discard(language);
}

/** The languages with a session alive right now. Exists for tests. */
export function openReplLanguages(): ReplLanguage[] {
  return [...sessions.keys()];
}
