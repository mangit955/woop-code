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
 * ## What is here and what is not
 *
 * The framed protocol — one JSON-encoded string of source per line in, output
 * followed by a per-session sentinel out — and the reasoning behind it live in
 * `replDrivers.ts` beside the two programs that speak it. *Starting* an
 * interpreter lives in the executor, because where it runs is the executor's
 * whole job: on this machine, or inside the sandbox with the boundary intact.
 *
 * What is left here is the part that is the same either way: the sentinel, the
 * frame reader, the timeout, the sessions map and what makes one unusable.
 */

import { randomUUID } from "node:crypto";
import { currentExecutor } from "../runtime/sandbox";
import type { Executor, ReplTransport } from "../runtime/sandbox";
import { ReplUnavailableError, type ReplLanguage } from "./replDrivers";

export { ReplUnavailableError, type ReplLanguage };

/** Characters of output kept from a single evaluation. */
export const MAX_REPL_OUTPUT = 16 * 1024;

/** How long one evaluation may run before the session is considered lost. */
export const DEFAULT_EVAL_TIMEOUT_SECONDS = 120;


interface Session {
  /** The pipe to the interpreter, wherever the executor put it. */
  transport: ReplTransport;
  /**
   * The executor this was started through.
   *
   * Kept so a session cannot outlive it. `/sandbox on` or `off` mid-turn swaps
   * the executor while this map still holds an interpreter attached to the old
   * one — reusing it would evaluate code in a place the user has just moved
   * away from, and in the `off` direction that place may not exist any more.
   */
  executor: Executor;
  sentinel: string;
  /** Output read past the last sentinel, belonging to no evaluation yet. */
  pending: string;
  /** Set when a timeout or a crash makes further evaluation meaningless. */
  broken: boolean;
}

const sessions = new Map<ReplLanguage, Session>();

async function startSession(language: ReplLanguage): Promise<Session> {
  const executor = currentExecutor();

  // Refused rather than run here. An executor that cannot host an interpreter
  // must not be answered by starting one on this machine: that is the whole
  // hole — `subprocess.run` from a local interpreter reaches everything a
  // sandboxed `run_terminal` was just stopped from reaching.
  if (!executor.startRepl) {
    throw new ReplUnavailableError(
      "The current execution environment cannot host an interpreter, so the repl " +
        "is not available. Use run_terminal instead.",
    );
  }

  const sentinel = `__woopcode_repl_${randomUUID()}__`;
  const transport = await executor.startRepl({ language, sentinel });

  return { transport, executor, sentinel, pending: "", broken: false };
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

    // Raced rather than awaited outright: a read on an interpreter that is busy
    // evaluating never settles, so without this the timeout above is
    // unreachable and a runaway loop hangs the turn instead of ending it.
    const chunk = await Promise.race([session.transport.read(), timeout]);

    if (chunk === "timeout") continue;
    if (chunk === null) {
      session.broken = true;
      throw new Error(
        "The interpreter exited. Its state is gone; the next call starts a fresh one.",
      );
    }

    session.pending += chunk;
  }
}

/**
 * Ends one session.
 *
 * How an interpreter is shut down belongs to the transport that started it —
 * the ordering that matters locally (stdin closed before the kill, or Bun holds
 * the process handle open waiting on a writer that never leaves) is in
 * `localExecutor.ts` beside the spawn it pairs with.
 */
function discard(language: ReplLanguage): void {
  const session = sessions.get(language);
  if (!session) return;
  sessions.delete(language);

  session.transport.close();
}

export interface EvalOptions {
  restart?: boolean;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

export interface EvalResult {
  output: string;
  /**
   * What the executor has to say about the evaluation, or "".
   *
   * Kept apart from `output` rather than concatenated onto it, because the
   * caller treats the two differently and would otherwise get both wrong: an
   * evaluation that printed nothing has a message of its own to give, and a
   * note folded in would make that branch unreachable — while output long
   * enough to be truncated would drop the note entirely, which is exactly when
   * a conflict is most worth reporting.
   */
  note: string;
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
  // And one belonging to an executor that is no longer current is not reusable
  // at all — its interpreter is in the wrong place, or nowhere.
  else if (existing && existing.executor !== currentExecutor()) discard(language);

  let session = sessions.get(language);
  const started = session === undefined;
  if (!session) {
    session = await startSession(language);
    sessions.set(language, session);
  }

  try {
    // Absent locally, where the interpreter is already looking at the real
    // tree. Before the write, so the code sees the files as they are now.
    await session.transport.beforeEval?.();

    // One line, so the driver's line-oriented read frames it. JSON.stringify is
    // what makes that safe for source containing newlines, quotes or backslashes.
    await session.transport.write(`${JSON.stringify(code)}\n`);

    const output = await readFrame(session, timeoutSeconds, signal);

    // After the frame, so what comes back is what the evaluation finished
    // writing. Never throws; an empty note is the ordinary case.
    const note = (await session.transport.afterEval?.()) ?? "";

    return { output, note, started };
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
