/**
 * The programs that turn an interpreter into something a tool can talk to.
 *
 * Their own file because two executors need them and neither should reach into
 * `replSession.ts` to get one: the local executor spawns an interpreter on this
 * machine, the sandbox executor starts one in a virtual machine, and the source
 * they run is the only thing the two have in common. Everything about *how* an
 * interpreter is launched belongs to the executor; everything about the
 * protocol belongs here.
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

export type ReplLanguage = "python" | "node";

/**
 * No interpreter to run this in.
 *
 * Lives here rather than in `replSession.ts` because both executors raise it
 * and `replSession.ts` imports the executor registry — putting it there would
 * make the two files import each other.
 */
export class ReplUnavailableError extends Error {}

export const REPL_LANGUAGES: ReplLanguage[] = ["python", "node"];

export function isReplLanguage(value: unknown): value is ReplLanguage {
  return typeof value === "string" && REPL_LANGUAGES.includes(value as ReplLanguage);
}

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
 *
 * `sys.argv[1]` is the sentinel whether this arrives through `-c` or as a file
 * on disk — with `-c` the source itself occupies `argv[0]`, and with a file the
 * path does. Python is the easy one here; see the note on node below.
 */
export const PYTHON_DRIVER = String.raw`
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
 *
 * **The sentinel is read from the last argument, not from `argv[1]`.** Where it
 * lands depends on how the driver was launched, and the two differ — measured:
 *
 *   node -e '<driver>' SENT   ->  [node, SENT]
 *   node /tmp/driver.js SENT  ->  [node, /tmp/driver.js, SENT]
 *
 * The local executor passes the source with `-e`; the sandbox one writes it to
 * a file, because shell-quoting this text into a command string is a bug farm.
 * Pinned to `argv[1]`, the file form would take the driver's own path as its
 * sentinel — no frame would ever match, and every evaluation would hang until
 * its timeout rather than fail. The last argument is right for both.
 */
export const NODE_DRIVER = String.raw`
const vm = require("vm");
const util = require("util");
const sentinel = process.argv[process.argv.length - 1];

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

/** What an executor needs to know to start one of these anywhere. */
export interface ReplDriver {
  /** Interpreter names to look for, in order. The first that resolves wins. */
  readonly candidates: readonly string[];
  readonly source: string;
  /** The extension to use when the source has to be written to a file. */
  readonly extension: string;
  /** The flag that makes the interpreter read the driver from an argument. */
  readonly inlineFlag: string;
  /** Flags that come before everything else, whichever way it is launched. */
  readonly leadingFlags: readonly string[];
}

export const REPL_DRIVERS: Record<ReplLanguage, ReplDriver> = {
  // `-u` because the driver's framing is only useful if it is not sitting in a
  // block-buffered pipe waiting for more.
  python: {
    candidates: ["python3", "python"],
    source: PYTHON_DRIVER,
    extension: "py",
    inlineFlag: "-c",
    leadingFlags: ["-u"],
  },
  node: {
    candidates: ["node", "bun"],
    source: NODE_DRIVER,
    extension: "js",
    inlineFlag: "-e",
    leadingFlags: [],
  },
};
