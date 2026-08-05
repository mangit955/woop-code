import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

/**
 * Returns the user configuration directory for Woopcode.
 * Creates the directory if it doesn't exist.
 *
 * Location:
 * - macOS/Linux: ~/.config/woopcode/
 * - Windows: %LOCALAPPDATA%\woopcode\
 *
 * The Windows branch is correct and unreachable in practice, and the
 * documentation no longer advertises the platform. `runCommand` in
 * tools/command.ts spawns `sh -c`, which Windows does not have, so
 * `run_terminal` and `run_tests` cannot run there — and the approval classifier
 * knows only POSIX command names, so every Windows command falls to its
 * fail-closed default and asks. Supporting the platform is a port, not a fix.
 *
 * Kept rather than deleted because it costs nothing, it is what WSL and any
 * later port would want, and removing it would make the gap harder to find
 * than this comment does.
 */
export function getConfigDir(): string {
  const home = homedir();

  let configDir: string;

  if (process.platform === "win32") {
    // Windows: Use LOCALAPPDATA
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    configDir = join(localAppData, "woopcode");
  } else {
    // macOS/Linux: Use XDG Base Directory Specification
    const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
    configDir = join(xdgConfigHome, "woopcode");
  }

  // Ensure directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  return configDir;
}

export function getProvidersConfigPath(): string {
  return join(getConfigDir(), "providers.json");
}

/**
 * The pre-sessions conversation file.
 *
 * Retained only so `migrateLegacyConversation` in config/sessions.ts can find
 * what an older version wrote. Nothing reads or writes it as live history any
 * more; sessions live under `sessions/<project>/`.
 */
export function getLegacyConversationPath(): string {
  return join(getConfigDir(), "conversation.json");
}

/** Root of the per-project session store. */
export function getSessionsDir(): string {
  return join(getConfigDir(), "sessions");
}

/**
 * Where one project's sessions live.
 *
 * Takes the slug rather than computing it, so the directory layout stays a pure
 * function of its argument and the slug rules live in one place
 * (`projectSlug`).
 */
export function getProjectSessionsDir(slug: string): string {
  return join(getSessionsDir(), slug);
}

export function getSessionPath(slug: string, id: string): string {
  return join(getProjectSessionsDir(slug), `${id}.json`);
}

export function getSessionIndexPath(slug: string): string {
  return join(getProjectSessionsDir(slug), "index.json");
}

/**
 * The pre-sessions execution log.
 *
 * It was kept beside the conversation because conversation.json was an array of
 * messages that older versions read directly, so widening it would have made a
 * downgrade fail on its own history. A session record has a version field and a
 * place to put it, so the log now lives inside the session and this path exists
 * only for the migration to drain.
 */
export function getLegacyExecutionLogPath(): string {
  return join(getConfigDir(), "execution-log.json");
}

export function getModelsPath(): string {
  return join(getConfigDir(), "models.json");
}

/**
 * Initialize configuration directory with default files if they don't exist.
 */
export async function initializeConfig(): Promise<void> {
  const providersPath = getProvidersConfigPath();

  // Create default providers.json if it doesn't exist
  if (!existsSync(providersPath)) {
    const defaultProviders = {
      defaultProvider: "google",
      providers: {
        google: {
          type: "api",
          apiKey: ""
        },
        openai: {
          type: "api",
          apiKey: ""
        },
        anthropic: {
          type: "api",
          apiKey: ""
        }
      }
    };

    await Bun.write(providersPath, JSON.stringify(defaultProviders, null, 2));
  } else {
    await removeRetiredProviders(providersPath);
  }

  // No conversation file is seeded any more. History lives in
  // sessions/<project>/, and a session file is written only once a turn has
  // actually run — an empty one would be a resume target with nothing in it.
}

/** Providers that were offered by an earlier version and have since been dropped. */
const RETIRED_PROVIDERS = ["groq"];

/**
 * Drops retired providers from an existing config. A stored API key is left
 * alone — that is the user's data, and removing the entry silently would hide
 * a credential they may still want to delete themselves.
 */
async function removeRetiredProviders(providersPath: string): Promise<void> {
  try {
    const config = JSON.parse(await Bun.file(providersPath).text());
    const providers = config?.providers;
    if (!providers) return;

    const removed = RETIRED_PROVIDERS.filter(
      (name) => providers[name] && !providers[name].apiKey,
    );
    if (removed.length === 0) return;

    for (const name of removed) {
      delete providers[name];
      if (config.defaultProvider === name) config.defaultProvider = "";
    }

    await Bun.write(providersPath, JSON.stringify(config, null, 2));
  } catch {
    // A malformed config is surfaced by getConfig(); never block startup here.
  }
}
