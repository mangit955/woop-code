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

/**
 * Get the path to providers.json
 */
export function getProvidersConfigPath(): string {
  return join(getConfigDir(), "providers.json");
}

/**
 * Get the path to conversation.json
 */
export function getConversationPath(): string {
  return join(getConfigDir(), "conversation.json");
}

/**
 * Get the path to models.json
 */
export function getModelsPath(): string {
  return join(getConfigDir(), "models.json");
}

/**
 * Initialize configuration directory with default files if they don't exist.
 */
export async function initializeConfig(): Promise<void> {
  const configDir = getConfigDir();
  const providersPath = getProvidersConfigPath();
  const conversationPath = getConversationPath();
  
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

  // Create empty conversation.json if it doesn't exist
  if (!existsSync(conversationPath)) {
    await Bun.write(conversationPath, JSON.stringify([], null, 2));
  }
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
