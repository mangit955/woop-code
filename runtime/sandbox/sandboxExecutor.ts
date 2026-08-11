/**
 * Running a command inside an E2B sandbox.
 *
 * The interesting part is not the call — it is the three ways a result can
 * arrive and the one way it must never arrive.
 *
 * **A non-zero exit is a result, not an error.** E2B throws `CommandExitError`
 * for any exit code other than zero. For a coding agent that is upside down: a
 * failing test suite is the answer to the question, not a broken sandbox. Left
 * unconverted, every red suite, every failing type check and every `grep` that
 * matched nothing would reach the model as an exception, and it would conclude
 * the machinery was broken rather than that its code was. The error carries the
 * same fields as a result, so this catches it and hands back the exit code.
 *
 * **Cancellation has to reach the command, not just the wait.** Every command
 * is started in the background so there is a pid to kill. Aborting the await
 * alone would leave the command running in a sandbox nobody is watching, still
 * writing to the tree the next command is about to read.
 *
 * **A sandbox that cannot be reached fails closed.** Never a local fallback:
 * a user who asked for isolation and silently ran on their own machine is worse
 * off than one who never asked for it. That holds for a background process too:
 * one started on this machine while `run_terminal` is sandboxed would hold a
 * real port and write to the real tree, which is the hole sandboxing closes. It
 * runs in the sandbox or it does not run.
 */

import type { CommandResult } from "../../tools/command";
import type { Executor, ProcessHandle } from "./executor";
import { REMOTE_WORKSPACE } from "./settings";
import {
  SandboxUnavailableError,
  withToolchainPath,
  type SandboxClient,
  type SandboxSession,
} from "./session";
import { describeForModel, emptyReport, type SyncReport } from "./sync";

/**
 * E2B's result shape, structurally.
 *
 * Both `CommandResult` and `CommandExitError` carry these, which is what makes
 * the conversion below a field copy rather than a special case.
 */
interface E2BResultLike {
  exitCode?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Reads an E2B result, or an E2B error that is really a result.
 *
 * Returns null for anything that does not carry an exit code, so a genuine
 * transport failure is not mistaken for a command that ran and failed.
 */
function resultFrom(value: unknown): CommandResult | null {
  if (!value || typeof value !== "object") return null;

  const candidate = value as E2BResultLike;
  if (typeof candidate.exitCode !== "number") return null;

  return {
    exitCode: candidate.exitCode,
    stdout: asText(candidate.stdout),
    stderr: asText(candidate.stderr),
  };
}

/** E2B's handle, structurally — a pid and something to wait on. */
interface E2BHandleLike {
  pid: number;
  wait(): Promise<unknown>;
}

function isHandle(value: unknown): value is E2BHandleLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as E2BHandleLike).pid === "number" &&
    typeof (value as E2BHandleLike).wait === "function"
  );
}

/**
 * Brings back what the command wrote, and tells the model about anything it
 * needs to know.
 *
 * The note is appended to stdout rather than stderr: a model reading a tool
 * result reads stdout first, and a conflict it does not see is a conflict it
 * cannot reconcile. Empty in the ordinary case — a line on every command would
 * be noise, and the one that mattered would go with it.
 */
async function withSync(
  session: SandboxSession,
  result: CommandResult,
  report: SyncReport,
): Promise<CommandResult> {
  try {
    await session.syncAfter(report);
  } catch (error) {
    return {
      ...result,
      stdout:
        `${result.stdout}\n\n[sandbox sync]\nThe command ran, but its changes could not ` +
        `be brought back: ${error instanceof Error ? error.message : String(error)}. ` +
        `Local files are unchanged.`,
    };
  }

  const note = describeForModel(report);
  return note ? { ...result, stdout: `${result.stdout}${note}` } : result;
}

/**
 * A background process running in the sandbox.
 *
 * **Output arrives before anything is listening.** E2B takes `onStdout` and
 * `onStderr` when the command starts, but `tools/process.ts` registers its sink
 * after `start()` has returned — locally that is harmless, because Bun's pipes
 * hold what was printed in the meantime. Here the callbacks fire into whatever
 * is there, so the chunks are buffered until a sink exists and flushed the
 * moment one does. Without it a server's startup banner, which is the one line
 * that says which port it chose, is gone before anyone can read it.
 */
class SandboxProcessHandle implements ProcessHandle {
  #session: SandboxSession;
  #client: SandboxClient;
  #pid: number;
  #report: SyncReport;
  #exitCode: number | null = null;
  #exited: Promise<number | null>;
  #buffer: OutputBuffer;

  constructor(
    session: SandboxSession,
    client: SandboxClient,
    started: E2BHandleLike,
    report: SyncReport,
    buffer: OutputBuffer,
  ) {
    this.#session = session;
    this.#client = client;
    this.#pid = started.pid;
    this.#report = report;
    this.#buffer = buffer;

    // A killed or failing command ends by throwing — the same landmine `run`
    // handles — so both settlements are read for an exit code rather than only
    // the resolution. Null for anything carrying none, which matches what the
    // local handle reports for a process killed by a signal.
    this.#exited = started.wait().then(
      (value) => resultFrom(value)?.exitCode ?? null,
      (error) => resultFrom(error)?.exitCode ?? null,
    );
    void this.#exited.then((code) => {
      this.#exitCode = code;
    });
  }

  get exitCode(): number | null {
    return this.#exitCode;
  }

  get exited(): Promise<number | null> {
    return this.#exited;
  }

  onOutput(sink: (chunk: string) => void): void {
    this.#buffer.attach(sink);
  }

  terminate(): void {
    // Synchronous and never throwing, per the interface: `stopAllProcesses`
    // runs at session exit and cannot await. `process_stop` waits on `exited`
    // itself, bounded, for the callers that need to know it landed.
    try {
      void this.#client.commands.kill(this.#pid).catch(() => {});
    } catch {
      // A client already torn down. There is nothing left to kill.
    }
  }

  unref(): void {
    // Nothing local holds the event loop open — the process is in a VM.
  }

  keepAlive(): void {
    void this.#session.keepAlive();
  }

  async syncBack(): Promise<string> {
    // A process can outlive its sandbox: `/sandbox off` disposes the session
    // and resets the executor, but the handles already handed to
    // `tools/process.ts` stay in its map. Going through `syncAfter` then would
    // reach `session.client()`, which *creates* one — booting a virtual machine
    // the user just turned off, and then diffing it against a snapshot taken
    // before all of it, which is a pull nobody asked for against a reference
    // that no longer describes anything.
    if (!this.#session.isRunning) {
      return (
        `\n\n[sandbox sync]\nThe sandbox was shut down before this process was ` +
        `stopped, so anything it wrote is gone with it. Local files are unchanged.`
      );
    }

    try {
      await this.#session.syncAfter(this.#report);
    } catch (error) {
      return (
        `\n\n[sandbox sync]\nThe process ran, but its changes could not be brought ` +
        `back: ${error instanceof Error ? error.message : String(error)}. ` +
        `Local files are unchanged.`
      );
    }

    return describeForModel(this.#report);
  }
}

/**
 * Chunks printed before anyone asked for them.
 *
 * Its own object because the sink has to be wired into `commands.run` before
 * the handle that owns it exists.
 */
class OutputBuffer {
  #pending: string[] = [];
  #sink: ((chunk: string) => void) | null = null;

  emit = (chunk: string): void => {
    if (this.#sink) this.#sink(chunk);
    else this.#pending.push(chunk);
  };

  attach(sink: (chunk: string) => void): void {
    this.#sink = sink;
    const pending = this.#pending;
    this.#pending = [];
    for (const chunk of pending) sink(chunk);
  }
}

export function createSandboxExecutor(session: SandboxSession): Executor {
  return {
    kind: "sandbox",

    async run(command, timeoutSeconds, signal, cwd): Promise<CommandResult> {
      if (signal?.aborted) throw new Error("Command cancelled");

      const client = await session.client();
      await session.keepAlive();

      // Local disk is authoritative for what goes in, so it goes in first. A
      // command reading a file the user edited a moment ago must see the edit.
      const report = emptyReport();
      await session.syncBefore(report);

      // Background, so the command has a pid that cancellation and the timeout
      // can actually kill. `timeoutMs: 0` disables E2B's own timer: the one
      // below is the one whose message the tools match on, and two timers
      // racing would sometimes produce the other one's wording.
      const started = await client.commands.run(withToolchainPath(command), {
        cwd: cwd ?? REMOTE_WORKSPACE,
        background: true,
        timeoutMs: 0,
      });

      if (!isHandle(started)) {
        throw new SandboxUnavailableError(
          "The sandbox did not return a process handle for the command.",
        );
      }

      const stop = () => {
        void client.commands.kill(started.pid).catch(() => {});
      };

      // Never rejects, so losing the race below cannot raise an unhandled
      // rejection later, and the settled outcome stays readable either way.
      const waiting = started.wait().then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      );

      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;

      // Raced rather than awaited after the kill. Killing and then waiting for
      // the command to notice assumes the kill lands — and when it does not,
      // because the sandbox is unreachable or the process ignores it, `wait()`
      // never settles and the turn hangs with nothing to end it. The local
      // executor bounds exactly this case; so does this.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          stop();
          reject(new Error(`Command timed out after ${timeoutSeconds} seconds`));
        }, timeoutSeconds * 1000);
      });

      const cancellation = new Promise<never>((_, reject) => {
        if (!signal) return;
        onAbort = () => {
          stop();
          reject(new Error("Command cancelled"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });

      try {
        const outcome = await Promise.race([waiting, timeout, cancellation]);

        // The landmine. E2B throws `CommandExitError` for any non-zero exit,
        // and it carries the same fields as a result — so a failing test suite
        // arrives here as an error and has to leave as an answer.
        const result = resultFrom(outcome.ok ? outcome.value : outcome.error);
        if (result) return await withSync(session, result, report);

        if (outcome.ok) {
          throw new SandboxUnavailableError(
            "The sandbox returned no exit code for the command.",
          );
        }

        const { error } = outcome;
        if (error instanceof SandboxUnavailableError) throw error;
        throw new SandboxUnavailableError(
          `The sandbox failed to run the command: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      } catch (error) {
        // A killed command has usually written something already — a `sed -i`
        // stopped half way, a build that produced most of its output. Leaving
        // that in the sandbox is the divergence this module exists to prevent,
        // so the pull is attempted even on the failing paths. Best-effort: a
        // sync that itself fails must not replace the error the caller needs.
        await session.syncAfter(report).catch(() => {});
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
    },

    async start(command, cwd): Promise<ProcessHandle> {
      const client = await session.client();
      await session.keepAlive();

      // Same order as `run`: local disk is authoritative for what goes in, so a
      // server starting now serves the file the user edited a moment ago. The
      // matching pull is at `process_stop` — the report is carried on the handle
      // until then, which is what makes that pull answerable about this process.
      const report = emptyReport();
      await session.syncBefore(report);

      // Wired before the command starts, because output that arrives in the
      // meantime has to land somewhere. See `SandboxProcessHandle`.
      const buffer = new OutputBuffer();

      const started = await client.commands.run(withToolchainPath(command), {
        cwd: cwd ?? REMOTE_WORKSPACE,
        background: true,
        // No timer at all, unlike `run`: this is a process that is *supposed*
        // to outlive the call. It ends at process_stop, when it dies on its
        // own, or when the sandbox does.
        timeoutMs: 0,
        onStdout: buffer.emit,
        onStderr: buffer.emit,
      });

      if (!isHandle(started)) {
        throw new SandboxUnavailableError(
          "The sandbox did not return a process handle for the command.",
        );
      }

      return new SandboxProcessHandle(session, client, started, report, buffer);
    },

    async urlForPort(port: number): Promise<string> {
      const client = await session.client();

      if (typeof client.getHost !== "function") {
        throw new SandboxUnavailableError(
          "This sandbox cannot publish a port, so there is no URL for it.",
        );
      }

      // E2B terminates TLS at its proxy, so the published URL is https even
      // though the server inside is listening on plain http.
      return `https://${client.getHost(port)}`;
    },
  };
}
