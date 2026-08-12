/**
 * Where a command runs.
 *
 * Every shell command in this codebase reaches the disk through two functions
 * in `tools/command.ts` — `runCommand` for the foreground and
 * `shellArgv` + `terminateProcessTree` for the background. This is the seam
 * across them, so a tool can run a command without knowing whether it lands on
 * this machine or in a sandbox somewhere else.
 *
 * It mirrors how the tools already work: `tools/terminal.ts` decides nothing
 * about whether a command is risky — it asks `tools/approval.ts` — and now it
 * decides nothing about where the command runs either.
 *
 * Only the local implementation exists at this point. It wraps the existing
 * functions and changes nothing about them.
 */

import type { CommandResult } from "../../tools/command";
import type { ReplLanguage } from "../../tools/replDrivers";

export interface Executor {
  /** Which implementation this is. Shown to the user; never branched on in a tool. */
  readonly kind: "local" | "sandbox";

  /**
   * Runs a command to completion.
   *
   * **Two error messages are interface, not description.** `tools/terminal.ts`
   * matches on them to tell the model what to do next — offering `process_start`
   * for something that was never going to exit, and a larger timeout for
   * something merely slow. An implementation that words them differently does
   * not fail; it silently stops that guidance from ever being produced:
   *
   *   - cancelled via the signal    `Command cancelled`
   *   - exceeded `timeoutSeconds`   `Command timed out after ${timeoutSeconds} seconds`
   *
   * Anything else is thrown as-is and handled by the caller as an unknown
   * failure.
   */
  run(
    command: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
    cwd?: string,
  ): Promise<CommandResult>;

  /**
   * Starts a command that outlives this call, returning a handle to it.
   *
   * The handle is the whole contract — nothing else may be assumed about the
   * process, because in a sandbox there is no local process to assume about.
   */
  start(command: string, cwd?: string): Promise<ProcessHandle>;

  /**
   * Where a server listening on `port` inside this executor can be reached.
   *
   * Exists so `process_start` can answer "what is the URL" without asking where
   * it is running: locally the port is simply on this machine, and in a sandbox
   * it is a hostname on E2B's proxy that nothing else could construct. A tool
   * calls this instead of branching on `kind`, which is the rule everywhere else
   * in this interface.
   *
   * Says nothing about whether anything is listening yet. A server started a
   * moment ago usually is not, and that is the caller's problem to describe.
   */
  urlForPort(port: number): Promise<string>;

  /**
   * Starts an interpreter that stays alive across calls, and hands back the
   * pipe to it.
   *
   * **Optional, and that is the safety property.** `tools/repl.ts` refuses when
   * this is absent rather than falling back to running code here, so an
   * executor kind added later is refused by default instead of quietly
   * reopening the hole this closes — an interpreter on the host has
   * `subprocess.run`, which reaches everything a sandboxed `run_terminal` was
   * just stopped from reaching.
   *
   * The driver's *source* is shared (`tools/replDrivers.ts`); how it is
   * launched is not, and that difference is why this is on the executor at all.
   */
  startRepl?(launch: ReplLaunch): Promise<ReplTransport>;
}

export interface ReplLaunch {
  language: ReplLanguage;
  /**
   * The per-session delimiter the driver prints after each result.
   *
   * Passed as the interpreter's last argument, which is where both driver
   * sources read it from — see the note in `replDrivers.ts` about why the
   * position and not `argv[1]`.
   */
  sentinel: string;
}

/**
 * A pipe to a live interpreter.
 *
 * Deliberately smaller than a `ProcessHandle`: nothing here waits for an exit
 * code, because an interpreter that exits has failed. Reading is pull-shaped
 * rather than the sink `ProcessHandle.onOutput` takes, because a caller framing
 * output against a sentinel needs to read until it sees one, not be handed
 * chunks whenever they arrive.
 */
export interface ReplTransport {
  /** Sends one framed line. Rejects if the interpreter cannot be reached. */
  write(line: string): Promise<void>;

  /**
   * The next piece of output, decoded, or null once the interpreter has ended.
   *
   * Decoding belongs to the implementation, not the caller: a multi-byte
   * character split across two chunks has to be carried between them, and one
   * decoder per session is the only place that can be done correctly.
   */
  read(): Promise<string | null>;

  /**
   * Ends the interpreter.
   *
   * Synchronous and never throwing, for the same reason as
   * `ProcessHandle.terminate`: `closeReplSessions` runs in the agent loop's
   * `finally` on every exit a turn has, and cannot await or catch.
   */
  close(): void;

  /**
   * Runs before an evaluation, for an executor where the interpreter is not
   * looking at the local disk.
   *
   * Absent locally. In a sandbox this is the push half of the transaction, and
   * the sandbox's lease being renewed.
   */
  beforeEval?(): Promise<void>;

  /**
   * Runs after an evaluation, returning a note for the model or "".
   *
   * Absent locally, where the interpreter has been writing to the real tree all
   * along. Never throws — a failed pull is reported in the note, because losing
   * the evaluation's output on top of its files helps nobody.
   */
  afterEval?(): Promise<string>;
}

export interface ProcessHandle {
  /**
   * The exit code, or null while it is still running.
   *
   * Tracked by the handle rather than read from the process: Bun reports null
   * for a process killed by a signal, so the value has to be captured when
   * `exited` settles rather than polled.
   */
  readonly exitCode: number | null;

  /** Settles when the process ends, however it ends. */
  readonly exited: Promise<number | null>;

  /**
   * Registers a sink for everything the process prints.
   *
   * One sink for both streams, interleaved. `tools/process.ts` buffers stdout
   * and stderr together and always has — a background process's output is read
   * as one transcript, and splitting it here would only make the caller
   * reassemble it.
   *
   * Call once per handle.
   */
  onOutput(sink: (chunk: string) => void): void;

  /**
   * Ends the process and everything it started.
   *
   * Best-effort, synchronous, and never throws. Synchronous because
   * `stopAllProcesses` runs at session exit and cannot await — a caller that
   * needs to know the process is gone waits on `exited` itself, bounded, which
   * is what `process_stop` does.
   */
  terminate(): void;

  /** Stops the process from holding the event loop open. */
  unref(): void;

  /**
   * Pushes back the deadline on whatever is hosting this process.
   *
   * Optional, and absent locally: a process on this machine has no lease to
   * renew. A sandbox does, and it is refreshed per command — so a development
   * server left running while the agent reads files would be reaped underneath
   * it with nothing to say so. Called by `process_output` and `process_stop`,
   * which are the only signs of life a background process produces.
   *
   * Fire and forget. A failed renewal is not worth failing a read over; the
   * next call against a dead sandbox reports it far more clearly.
   */
  keepAlive?(): void;

  /**
   * Brings back what the process wrote, and describes anything the model needs
   * to know about it.
   *
   * Optional, and absent locally, where a background process writes to the real
   * tree as it goes and there is nothing to bring back. In a sandbox the pull
   * happens once, at `process_stop`: doing it per `process_output` would put a
   * remote listing and a diff behind a call the model makes in a tight polling
   * loop.
   *
   * Returns a note to append to the result, empty when there is nothing to say.
   * Never throws — a sync that failed is reported in the note, because losing
   * the process's output on top of losing its files helps nobody.
   */
  syncBack?(): Promise<string>;
}
