/**
 * Which executor the tools are currently using.
 *
 * Module state rather than a parameter on `Tool.execute`, because only three
 * tools need it and threading it through would change the `Tool` interface in
 * `config/types.ts` and every tool's signature. The codebase already reaches
 * session-wide state from inside a tool exactly this way: `tools/approval.ts`
 * imports the UI store and calls `getApprovalMode()` directly, and
 * `tools/process.ts` keeps its process map at module level.
 *
 * Its own file rather than part of `index.ts` so `control.ts` can set the
 * executor without importing the barrel that re-exports `control.ts` itself.
 *
 * Local until something says otherwise, so nothing changes for a session that
 * never asks for a sandbox.
 */

import type { Executor } from "./executor";
import { localExecutor } from "./localExecutor";

let current: Executor = localExecutor;

/**
 * The executor a command should run through.
 *
 * Read per command rather than captured, so switching mid-session takes effect
 * on the next command — the same reason `getApprovalMode` is read per command
 * rather than cached.
 */
export function currentExecutor(): Executor {
  return current;
}

export function setExecutor(executor: Executor): void {
  current = executor;
}

/**
 * Back to running on this machine.
 *
 * For session teardown and for tests: a test that sets an executor and does not
 * restore it would leave every later test in the file — and, since module state
 * outlives a file, the whole run — pointed at its fake.
 */
export function resetExecutor(): void {
  current = localExecutor;
}

/**
 * Whether commands are currently leaving this machine.
 *
 * `!== "local"` rather than `=== "sandbox"`: a tool asking this wants to know
 * whether it may touch the real disk, and a third kind of executor added later
 * should default to "no" rather than silently reopening the hole.
 */
export function isSandboxed(): boolean {
  return current.kind !== "local";
}
