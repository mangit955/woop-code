import { isProviderEnabled } from "./providerRegistry";

/**
 * Credentials sourced from the process environment rather than from
 * `providers.json`.
 *
 * Woopcode normally stores a key on disk after the onboarding wizard runs.
 * That flow assumes a terminal and a human. Automated harnesses — Harbor
 * benchmark containers, CI — have neither: the container is built fresh for
 * every trial, so there is no config file to read, and there is no TTY to
 * drive the wizard with. Reading credentials from the environment gives those
 * callers a way to configure Woopcode without a writable home directory or an
 * interactive session.
 */
export interface EnvCredentials {
  provider: string;
  apiKey: string;
  /** The variable the key was read from, for diagnostics. */
  source: string;
}

/**
 * Environment variables that supply an API key, in precedence order.
 *
 * `WOOPCODE_API_KEY` is the explicit, provider-agnostic form and is paired
 * with `WOOPCODE_PROVIDER`. The remaining names are the conventional
 * per-vendor variables, so an environment already set up for another tool
 * works without extra configuration.
 */
const KEY_VARS: { env: string; provider: string }[] = [
  { env: "WOOPCODE_API_KEY", provider: "" }, // provider comes from WOOPCODE_PROVIDER
  { env: "GEMINI_API_KEY", provider: "google" },
  { env: "GOOGLE_API_KEY", provider: "google" },
  { env: "GOOGLE_GENERATIVE_AI_API_KEY", provider: "google" },
  { env: "OPENAI_API_KEY", provider: "openai" },
  { env: "ANTHROPIC_API_KEY", provider: "anthropic" },
];

/** The provider used when a key is given without naming one. */
const DEFAULT_ENV_PROVIDER = "google";

/**
 * Resolves provider credentials from the environment, or null when none are
 * present.
 *
 * A key for a provider Woopcode cannot run is rejected here rather than
 * stored, matching `loginProvider`: it is better to say so at startup than to
 * fail on the first turn.
 *
 * @throws If a key is present but names a provider with no runtime client.
 */
export function resolveEnvCredentials(
  env: Record<string, string | undefined> = process.env,
): EnvCredentials | null {
  for (const { env: name, provider: implied } of KEY_VARS) {
    const apiKey = env[name]?.trim();
    if (!apiKey) continue;

    const provider = (
      implied || env.WOOPCODE_PROVIDER?.trim() || DEFAULT_ENV_PROVIDER
    ).toLowerCase();

    if (!isProviderEnabled(provider)) {
      throw new Error(
        `${name} is set but provider "${provider}" has no runtime client in this build. ` +
          `Set WOOPCODE_PROVIDER to a supported provider, or unset ${name}.`,
      );
    }

    return { provider, apiKey, source: name };
  }

  return null;
}

/**
 * Whether Woopcode may open an interactive prompt.
 *
 * The onboarding wizard renders with Ink and waits for keystrokes. Without a
 * TTY it would render into a pipe and block forever, which inside a benchmark
 * container reads as a hung agent rather than a configuration error. Callers
 * use this to fail loudly instead.
 */
export function canPromptInteractively(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.WOOPCODE_NON_INTERACTIVE === "1") return false;
  if (env.CI === "true" || env.CI === "1") return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
