/**
 * Reading what E2B hands back.
 *
 * Its own file because both the executor and the repl transport need it and
 * neither can import the other. Structural rather than typed against the SDK,
 * so the fakes in `packages/tests/sandbox/` stay six methods rather than the
 * whole client.
 */

import type { CommandResult } from "../../tools/command";

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
export function resultFrom(value: unknown): CommandResult | null {
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
export interface E2BHandleLike {
  pid: number;
  wait(): Promise<unknown>;
}

export function isHandle(value: unknown): value is E2BHandleLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as E2BHandleLike).pid === "number" &&
    typeof (value as E2BHandleLike).wait === "function"
  );
}

/** The same, plus the two calls an interactive session needs. */
export interface E2BStdinHandleLike extends E2BHandleLike {
  sendStdin(data: string): Promise<void>;
  closeStdin(): Promise<void>;
}

export function isStdinHandle(value: unknown): value is E2BStdinHandleLike {
  return (
    isHandle(value) &&
    typeof (value as E2BStdinHandleLike).sendStdin === "function" &&
    typeof (value as E2BStdinHandleLike).closeStdin === "function"
  );
}
