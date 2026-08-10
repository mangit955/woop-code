/**
 * Turning the sandbox on and off.
 *
 * The session and the executor have to move together — an executor pointed at a
 * disposed sandbox, or a live sandbox nothing is routed to, are both silent
 * failures — so nothing sets one without the other. Module state for the same
 * reason `currentExecutor` is: a tool and a slash command both need it, and
 * neither is handed a context object.
 *
 * Enabling does not create a sandbox. The session creates one on the first
 * command, so `/sandbox on` followed by a conversation that only reads files
 * costs nothing.
 */

import { createE2BSandbox } from "./e2bClient";
import { resolveSandboxSettings } from "./settings";
import { SandboxSession, type CreateSandbox } from "./session";
import { createSandboxExecutor } from "./sandboxExecutor";
import { resetExecutor, setExecutor } from "./registry";

let session: SandboxSession | null = null;

export interface EnableOptions {
  workspace?: string;
  /** `--sandbox-network`, when given. */
  network?: string;
  onStatus?: (message: string) => void;
  /** Injected by tests; the real E2B client otherwise. */
  createSandbox?: CreateSandbox;
  env?: Record<string, string | undefined>;
}

/**
 * Routes commands into a sandbox from the next command onwards.
 *
 * Returns what was refused from the forwarding allowlist, so the caller can say
 * so: a token silently not forwarded looks like a broken build later.
 */
export function enableSandbox(options: EnableOptions = {}): { refusedEnv: string[] } {
  const { settings, refusedEnv } = resolveSandboxSettings(options.env ?? process.env, {
    ...(options.network !== undefined ? { network: options.network } : {}),
  });

  // Replaced rather than reused: settings may have changed, and a second
  // sandbox held by a discarded session would bill until its timeout.
  void disableSandbox();

  session = new SandboxSession({
    settings,
    workspace: options.workspace ?? process.cwd(),
    createSandbox: options.createSandbox ?? createE2BSandbox,
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
  });

  setExecutor(createSandboxExecutor(session));

  return { refusedEnv };
}

/**
 * Back to running on this machine, and the sandbox taken down.
 *
 * The executor is reset first: if killing hangs or fails, the next command must
 * still have somewhere to run rather than being routed at a corpse.
 */
export async function disableSandbox(): Promise<void> {
  const previous = session;
  session = null;
  resetExecutor();

  if (previous) await previous.dispose();
}

export function sandboxSession(): SandboxSession | null {
  return session;
}

export function isSandboxEnabled(): boolean {
  return session !== null;
}
