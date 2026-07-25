import type { SlashCommand, SlashCommandContext } from "./types";
import { registry } from "./registry";
import {
  getConfig,
  saveConfig,
  getConversation,
  saveConversation,
} from "../../config/config";

// Read version from package.json
const packageJsonPath = `${import.meta.dir}/../../package.json`;
const packageJson = await Bun.file(packageJsonPath).json();
const version = packageJson.version as string;

// Read models from models.json
const modelsJsonPath = `${import.meta.dir}/../../config/models.json`;
const modelsData = await Bun.file(modelsJsonPath).json();
const models = modelsData as Array<{
  id: string;
  provider: string;
  name: string;
  contextWindow: number | string;
}>;

// ==================== SESSION COMMANDS ====================

const helpCommand: SlashCommand = {
  name: "help",
  aliases: ["h", "?"],
  description: "Show available commands",
  category: "other",

  async execute(context, args) {
    return registry.generateHelp();
  },
};

const newCommand: SlashCommand = {
  name: "new",
  aliases: ["clear", "reset"],
  description: "Start a new conversation",
  category: "session",

  async execute(context, args) {
    await saveConversation([]);
    return "Started new conversation";
  },
};

const exitCommand: SlashCommand = {
  name: "exit",
  aliases: ["quit", "q"],
  description: "Exit Woopcode",
  category: "session",

  async execute(context, args) {
    await context.onExit();
    return "Exiting...";
  },
};

// ==================== CONFIGURATION COMMANDS ====================

const providerCommand: SlashCommand = {
  name: "provider",
  aliases: ["p"],
  description: "Show or switch provider",
  category: "configuration",
  usage: "/provider [provider-name]",

  async execute(context, args) {
    const config = await getConfig();

    if (args.length === 0) {
      const current = config.defaultProvider;
      const providers = Object.entries(config.providers)
        .map(([name, details]: [string, any]) => {
          const status = details.apiKey ? "✓" : "✗";
          const active = name === current ? "(active)" : "";
          return `  ${status} ${name} ${active}`;
        })
        .join("\n");

      return `Current Provider: ${current}\n\nAvailable:\n${providers}\n\nTip: Use /login or /logout to manage authentication`;
    }

    const newProvider = args[0];
    if (!newProvider) {
      return `Provider name required.\nUsage: /provider <provider-name>`;
    }
    
    const available = Object.keys(config.providers);

    if (!available.includes(newProvider)) {
      return `Provider "${newProvider}" not found.\nAvailable: ${available.join(", ")}`;
    }

    const providerConfig = config.providers[newProvider];
    if (!providerConfig || !providerConfig.apiKey) {
      return `Provider "${newProvider}" not configured.\nUse: /login ${newProvider} <api-key>`;
    }

    config.defaultProvider = newProvider;
    await saveConfig(config);

    return `Switched to: ${newProvider}`;
  },
};

const modelCommand: SlashCommand = {
  name: "model",
  aliases: ["m"],
  description: "Show current model and available models",
  category: "configuration",

  async execute(context, args) {
    const config = await getConfig();
    const provider = config.defaultProvider;

    // Show current model (read-only for now)
    let output = `Current Model: gemini-3.5-flash-lite\n\n`;

    // List available models for current provider
    const providerModels = models.filter((m) => m.provider === provider);

    if (providerModels.length > 0) {
      output += `Available models for ${provider}:\n`;
      providerModels.forEach((m) => {
        output += `  ${m.id} - ${m.name}\n`;
      });
    }

    return output.trim();
  },
};

const loginCommand: SlashCommand = {
  name: "login",
  description: "Login to a provider",
  category: "configuration",
  usage: "/login <provider> <api-key>",

  async execute(context, args) {
    if (args.length < 2) {
      return `Usage: /login <provider> <api-key>\nExample: /login google YOUR_API_KEY`;
    }

    const provider = args[0];
    const apiKey = args.slice(1).join(" "); // Allow API keys with spaces

    const config = await getConfig();

    if (!config.providers[provider]) {
      const available = Object.keys(config.providers);
      return `Unknown provider "${provider}".\nAvailable: ${available.join(", ")}`;
    }

    // Validate API key
    const { loginProvider } = await import("../../config/authProvider");
    const isValid = await loginProvider(provider, apiKey);

    if (!isValid) {
      return `Invalid API key for ${provider}.\nPlease check your API key and try again.`;
    }

    // Save the API key
    config.providers[provider].apiKey = apiKey;
    config.defaultProvider = provider;
    await saveConfig(config);

    return `Successfully logged in to ${provider}!\nThis is now your active provider.`;
  },
};

const logoutCommand: SlashCommand = {
  name: "logout",
  description: "Logout from a provider",
  category: "configuration",
  usage: "/logout [provider]",

  async execute(context, args) {
    const config = await getConfig();

    // If no provider specified, logout from current
    const provider = args[0] || config.defaultProvider;

    if (!config.providers[provider]) {
      const available = Object.keys(config.providers);
      return `Unknown provider "${provider}".\nAvailable: ${available.join(", ")}`;
    }

    const providerConfig = config.providers[provider];
    if (!providerConfig?.apiKey) {
      return `Already logged out from ${provider}.`;
    }

    // Remove API key
    delete config.providers[provider].apiKey;

    // If logging out from default provider, clear default
    if (config.defaultProvider === provider) {
      // Find another logged-in provider
      const otherProvider = Object.entries(config.providers).find(
        ([name, details]: [string, any]) => name !== provider && details.apiKey
      );

      if (otherProvider) {
        config.defaultProvider = otherProvider[0];
      } else {
        config.defaultProvider = "";
      }
    }

    await saveConfig(config);

    const nextProvider = config.defaultProvider
      ? `\nActive provider: ${config.defaultProvider}`
      : "\nNo providers logged in. Use /login to authenticate.";

    return `Logged out from ${provider}.${nextProvider}`;
  },
};

// ==================== WORKSPACE COMMANDS ====================

const workspaceCommand: SlashCommand = {
  name: "workspace",
  aliases: ["ws"],
  description: "Show workspace information",
  category: "workspace",

  async execute(context, args) {
    const cwd = process.cwd();
    const parts = cwd.split("/").filter(Boolean);
    const repoName = parts[parts.length - 1] ?? "unknown";

    let branch = "not a git repository";
    try {
      branch =
        (await Bun.$`git branch --show-current`.text()).trim() || "detached";
    } catch {}

    let fileCount = 0;
    try {
      for await (const entry of new Bun.Glob("**/*").scan(cwd)) {
        if (
          !entry.startsWith("node_modules") &&
          !entry.startsWith(".git") &&
          !entry.startsWith("dist")
        ) {
          fileCount++;
        }
      }
    } catch {}

    return [
      `Workspace: ${repoName}`,
      `Path: ${cwd}`,
      `Branch: ${branch}`,
      `Files: ${fileCount > 0 ? fileCount : "counting..."}`,
    ].join("\n");
  },
};

const statusCommand: SlashCommand = {
  name: "status",
  aliases: ["info"],
  description: "Show comprehensive system status",
  category: "other",

  async execute(context, args) {
    const config = await getConfig();
    const conversation = await getConversation();
    const cwd = process.cwd();
    const parts = cwd.split("/").filter(Boolean);
    const repoName = parts[parts.length - 1] ?? "workspace";

    let branch = "not a git repository";
    try {
      branch =
        (await Bun.$`git branch --show-current`.text()).trim() || "detached";
    } catch {}

    const provider = config.defaultProvider;
    const providerLabel = provider === "google" ? "Google Gemini" : provider;

    return [
      `Workspace: ${repoName}`,
      `Path: ${cwd}`,
      `Branch: ${branch}`,
      ``,
      `Provider: ${providerLabel}`,
      `Model: gemini-3.5-flash-lite`,
      ``,
      `Conversation: ${conversation.length} messages`,
      `Tools: 9 registered`,
      `Version: ${version}`,
    ].join("\n");
  },
};

// ==================== OTHER COMMANDS ====================

const versionCommand: SlashCommand = {
  name: "version",
  aliases: ["v"],
  description: "Show Woopcode version",
  category: "other",

  async execute(context, args) {
    return `Woopcode v${version}`;
  },
};

// ==================== REGISTRATION ====================

export function registerCommands() {
  registry.register(helpCommand);
  registry.register(newCommand);
  registry.register(exitCommand);
  registry.register(providerCommand);
  registry.register(loginCommand);
  registry.register(logoutCommand);
  registry.register(modelCommand);
  registry.register(workspaceCommand);
  registry.register(statusCommand);
  registry.register(versionCommand);
}
