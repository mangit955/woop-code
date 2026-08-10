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
 * off than one who never asked for it.
 */

import type { CommandResult } from "../../tools/command";
import type { Executor, ProcessHandle } from "./executor";
import { REMOTE_WORKSPACE } from "./settings";
import {
  SandboxUnavailableError,
  withToolchainPath,
  type SandboxSession,
} from "./session";

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

export function createSandboxExecutor(session: SandboxSession): Executor {
  return {
    kind: "sandbox",

    async run(command, timeoutSeconds, signal, cwd): Promise<CommandResult> {
      if (signal?.aborted) throw new Error("Command cancelled");

      const client = await session.client();
      await session.keepAlive();

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
        if (result) return result;

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
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
    },

    async start(): Promise<ProcessHandle> {
      // Refused rather than quietly run on this machine. A background process
      // started locally while `run_terminal` is sandboxed would write to the
      // real tree and hold real ports — the exact hole sandboxing closes.
      throw new Error(
        "Background processes are not available while the sandbox is on. " +
          "Use run_terminal for a command that finishes on its own, or turn the " +
          "sandbox off with /sandbox off to start a server locally.",
      );
    },
  };
}
