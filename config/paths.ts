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
        groq: {
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
  }
  
  // Create empty conversation.json if it doesn't exist
  if (!existsSync(conversationPath)) {
    await Bun.write(conversationPath, JSON.stringify([], null, 2));
  }
}
