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
