/**
 * The one place the E2B SDK is constructed.
 *
 * Everything else in this directory talks to `SandboxClient`, so the SDK's shape
 * is a detail of this file and the lifecycle and executor can be tested against
 * a fake without a key or a network.
 */

import { Sandbox } from "e2b";
import type { SandboxClient } from "./session";
import { SandboxUnavailableError } from "./session";
import type { SandboxSettings } from "./settings";

export function hasApiKey(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.E2B_API_KEY?.trim());
}

/**
 * Creates a real sandbox.
 *
 * The missing-key case is checked here rather than left to the SDK, because the
 * message a user needs is "set E2B_API_KEY" and not whatever an authentication
 * failure happens to say.
 */
export const createE2BSandbox = async (
  settings: SandboxSettings,
): Promise<SandboxClient> => {
  if (!hasApiKey()) {
    throw new SandboxUnavailableError(
      "E2B_API_KEY is not set, so there is nowhere to run a sandboxed command. " +
        "Set it, or turn the sandbox off with /sandbox off.",
    );
  }

  const options = {
    timeoutMs: settings.timeoutMs,
    ...(Object.keys(settings.envs).length > 0 ? { envs: settings.envs } : {}),
    // Allow rules take precedence in E2B, so denying all traffic with nothing
    // allowed is the way to express "no egress" rather than a partial block.
    ...(settings.network === "none"
      ? { network: { denyOut: ({ allTraffic }: { allTraffic: string }) => [allTraffic] } }
      : {}),
  };

  const sandbox = settings.template
    ? await Sandbox.create(settings.template, options)
    : await Sandbox.create(options);

  return sandbox as unknown as SandboxClient;
};
