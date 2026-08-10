/**
 * How a sandbox is configured, read from the environment.
 *
 * Kept apart from the sandbox itself so every rule here can be tested without a
 * network — particularly the environment allowlist, which is the difference
 * between a credential staying on this machine and a credential being uploaded.
 */

import { DEFAULT_MAX_FILE_BYTES } from "./transmittable";

/** Where the workspace lives inside a sandbox. */
export const REMOTE_WORKSPACE = "/home/user/workspace";

/**
 * How long a sandbox lives without being touched.
 *
 * Ten minutes rather than E2B's default five. Five is exactly
 * `run_terminal`'s own default timeout, so a command using its whole budget
 * would race the reaper for its life and the winner would be luck. The lifetime
 * is refreshed before every command anyway; this is only the window a *single*
 * command has to finish in.
 */
export const DEFAULT_SANDBOX_TIMEOUT_MS = 10 * 60_000;

/**
 * Credentials that are never forwarded, however they are asked for.
 *
 * The allowlist below exists so a build can be given a registry token. It is
 * not a way to hand the sandbox the keys to the agent itself: a prompt-injected
 * model that talks its user into `WOOPCODE_SANDBOX_ENV=WOOPCODE_API_KEY` should
 * get nothing. Matched case-insensitively as a substring, because the shape of
 * the name is the signal.
 */
const NEVER_FORWARD = [
  "WOOPCODE_API_KEY",
  "E2B_API_KEY",
  "ANTHROPIC",
  "OPENAI",
  "GEMINI",
  "GOOGLE_API",
  "GOOGLE_GENAI",
];

export function isForwardableName(name: string): boolean {
  const upper = name.toUpperCase();
  return !NEVER_FORWARD.some((blocked) => upper.includes(blocked));
}

export type NetworkMode = "full" | "none";

export function parseNetworkMode(value: unknown): NetworkMode {
  // Anything unreadable lands on the default rather than on the permissive
  // reading of a typo — the same rule `parseApprovalMode` follows.
  return value === "none" ? "none" : "full";
}

export interface SandboxSettings {
  /** Template id, or undefined for E2B's base. */
  template?: string;
  timeoutMs: number;
  maxFileBytes: number;
  network: NetworkMode;
  /** Variables forwarded into the sandbox, already filtered. */
  envs: Record<string, string>;
  /** Command run once after the workspace is pushed, or undefined for the default. */
  setupCommand?: string;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The variables named by `WOOPCODE_SANDBOX_ENV`, minus anything on the
 * never-forward list and anything not actually set.
 *
 * Returns the values too, so the caller does not have to reach back into the
 * environment and risk picking up a name this function refused.
 */
export function forwardedEnv(
  requested: string | undefined,
  source: Record<string, string | undefined>,
): { envs: Record<string, string>; refused: string[] } {
  const envs: Record<string, string> = {};
  const refused: string[] = [];

  if (!requested?.trim()) return { envs, refused };

  for (const raw of requested.split(",")) {
    const name = raw.trim();
    if (!name) continue;

    if (!isForwardableName(name)) {
      refused.push(name);
      continue;
    }

    const value = source[name];
    if (typeof value === "string") envs[name] = value;
  }

  return { envs, refused };
}

export interface ResolveOptions {
  /** `--sandbox-network`, when given on the command line. */
  network?: string;
}

export function resolveSandboxSettings(
  env: Record<string, string | undefined> = process.env,
  options: ResolveOptions = {},
): { settings: SandboxSettings; refusedEnv: string[] } {
  const { envs, refused } = forwardedEnv(env.WOOPCODE_SANDBOX_ENV, env);

  return {
    settings: {
      ...(env.WOOPCODE_SANDBOX_TEMPLATE?.trim()
        ? { template: env.WOOPCODE_SANDBOX_TEMPLATE.trim() }
        : {}),
      timeoutMs: positiveInteger(env.WOOPCODE_SANDBOX_TIMEOUT_MS, DEFAULT_SANDBOX_TIMEOUT_MS),
      maxFileBytes: positiveInteger(env.WOOPCODE_SANDBOX_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES),
      network: parseNetworkMode(options.network ?? env.WOOPCODE_SANDBOX_NETWORK),
      envs,
      ...(env.WOOPCODE_SANDBOX_SETUP?.trim()
        ? { setupCommand: env.WOOPCODE_SANDBOX_SETUP.trim() }
        : {}),
    },
    refusedEnv: refused,
  };
}

/**
 * Installing bun, for the case the base template does not have it.
 *
 * Measured: E2B's base template carries node, npm, python3, git, gcc, make,
 * curl and tar, and no bun — so a repository whose test command is `bun test`
 * cannot run its own suite in a stock sandbox. Run only when the pushed tree
 * has a `bun.lock`, so a Python repository never pays for it.
 */
export const BUN_INSTALL_COMMAND =
  "curl -fsSL https://bun.sh/install | bash && " +
  'echo \'export PATH="$HOME/.bun/bin:$PATH"\' >> "$HOME/.bashrc"';

/** Where bun lands, so commands can find it without a login shell. */
export const BUN_PATH_PREFIX = "$HOME/.bun/bin";
