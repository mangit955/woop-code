import type { SlashCommand, SlashCommandContext } from "./types";
import { registry } from "./registry";
import { APPROVAL_MODES, describeApprovalMode, parseApprovalMode } from "../../runtime/approval";
import {
  getConfig,
  saveConfig,
  getConversation,
  saveConversation,
} from "../../config/config";
import {
  getProviderInfo,
  isProviderEnabled,
  unsupportedProviderMessage,
} from "../../config/providerRegistry";
import { DEFAULT_MODEL_ID, getModelDisplayName } from "../../config/client";
import { toolRegistery } from "../../tools";
import { VERSION } from "../../config/version";
// Imported rather than read through import.meta.dir at load time, which was a
// path-resolution failure waiting to happen and diverged from commands/models.ts.
// This is a shipped asset, not user data: if it is unreadable the install is
// broken, and failing loudly is the right outcome. User-owned files
// (providers.json, conversation.json) are recovered instead — see config.ts.
import modelsData from "../../config/models.json";

const models = modelsData as Array<{
  id: string;
  provider: string;
  name: string;
  contextWindow: number | string;
}>;

/**
 * The model the next turn will use. The running controller is authoritative —
 * a model chosen in the picker is applied there first — with the saved
 * selection as the fallback for contexts without a live controller.
 */
function activeModel(
  context: SlashCommandContext,
  config: { selectedModel?: string },
): string {
  return context.controller?.getModel?.() ?? config.selectedModel ?? DEFAULT_MODEL_ID;
}

/** Human-readable provider name, from the same registry the rest of the CLI uses. */
function providerLabel(provider: string): string {
  return getProviderInfo(provider)?.name ?? provider ?? "none";
}

/**
 * Keeps the selected model consistent with the provider. Returns a model id
 * when the current selection belongs to a different provider, and undefined
 * when the user's choice is still valid (or the provider lists no models).
 */
function modelForProvider(provider: string, currentModel: string | undefined) {
  const providerModels = models.filter((model) => model.provider === provider);

  if (providerModels.length === 0) return undefined;
  if (currentModel && providerModels.some((model) => model.id === currentModel)) {
    return undefined;
  }

  return providerModels[0]?.id;
}

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
    
    // Clear UI timeline as well
    const { store } = await import("../../tui/src/store/ui-store");
    store.clearTimeline();
    
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
          const support = isProviderEnabled(name) ? "" : "(not supported yet)";
          return `  ${status} ${name} ${active}${support}`;
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

    if (!isProviderEnabled(newProvider)) {
      return unsupportedProviderMessage(newProvider);
    }

    const providerConfig = config.providers[newProvider];
    if (!providerConfig || !providerConfig.apiKey) {
      return `Provider "${newProvider}" not configured.\nUse: /login ${newProvider} <api-key>`;
    }

    if (context.controller.isBusy()) {
      return `Cannot switch provider while the agent is running. Press Esc to cancel first.`;
    }

    const model = modelForProvider(newProvider, config.selectedModel);

    // The running controller holds its own provider/key, so the config write
    // alone would leave this session on the previous provider.
    context.controller.setProvider(newProvider, providerConfig.apiKey, model);

    config.defaultProvider = newProvider;
    if (model) config.selectedModel = model;
    await saveConfig(config);

    if (model) {
      const { store } = await import("../../tui/src/store/ui-store");
      store.setSelectedModel(model);
    }

    return `Switched to: ${newProvider}${model ? ` (${model})` : ""}`;
  },
};

const modelCommand: SlashCommand = {
  name: "models",
  aliases: ["model", "m"],
  description: "Show the active model and those available for this provider",
  category: "configuration",

  async execute(context, args) {
    const config = await getConfig();
    const provider = config.defaultProvider;
    const current = activeModel(context, config);

    let output = `Current Model: ${getModelDisplayName(current)} (${current})\n\n`;

    const providerModels = models.filter((m) => m.provider === provider);

    if (providerModels.length === 0) {
      output += `No models are listed for ${providerLabel(provider)}.`;
      return output.trim();
    }

    output += `Available models for ${providerLabel(provider)}:\n`;
    providerModels.forEach((m) => {
      const marker = m.id === current ? " (current)" : "";
      output += `  ${m.id} - ${m.name}${marker}\n`;
    });

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
    if (!provider) {
      return `Provider name required.\nUsage: /login <provider> <api-key>`;
    }
    const apiKey = args.slice(1).join(" "); // Allow API keys with spaces

    const config = await getConfig();

    if (!config.providers[provider]) {
      const available = Object.keys(config.providers);
      return `Unknown provider "${provider}".\nAvailable: ${available.join(", ")}`;
    }

    if (!isProviderEnabled(provider)) {
      return unsupportedProviderMessage(provider);
    }

    // Validate API key
    const { loginProvider } = await import("../../config/authProvider");
    const isValid = await loginProvider(provider, apiKey);

    if (!isValid) {
      return `Invalid API key for ${provider}.\nPlease check your API key and try again.`;
    }

    if (context.controller.isBusy()) {
      return `Cannot change provider while the agent is running. Press Esc to cancel first.`;
    }

    // Save the API key
    config.providers[provider].apiKey = apiKey;
    config.defaultProvider = provider;

    const model = modelForProvider(provider, config.selectedModel);
    if (model) config.selectedModel = model;
    await saveConfig(config);

    // A re-login with a fresh key must reach the running session too, not just
    // the config file.
    context.controller.setProvider(provider, apiKey, model);

    if (model) {
      const { store } = await import("../../tui/src/store/ui-store");
      store.setSelectedModel(model);
    }

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

    if (
      config.defaultProvider === provider &&
      context.controller.isBusy()
    ) {
      return `Cannot log out of the active provider while the agent is running. Press Esc to cancel first.`;
    }

    // Remove API key
    delete config.providers[provider].apiKey;

    // If logging out from default provider, clear default
    if (config.defaultProvider === provider) {
      // Find another logged-in provider
      const otherProvider = Object.entries(config.providers).find(
        ([name, details]: [string, any]) =>
          name !== provider && details.apiKey && isProviderEnabled(name)
      );

      if (otherProvider) {
        config.defaultProvider = otherProvider[0];
      } else {
        config.defaultProvider = "";
      }

      // Drop the revoked key from the live session as well. With no provider
      // left, the next turn reports that instead of using stale credentials.
      const nextKey = config.defaultProvider
        ? config.providers[config.defaultProvider]?.apiKey ?? ""
        : "";
      const nextModel = modelForProvider(
        config.defaultProvider,
        config.selectedModel,
      );
      if (nextModel) config.selectedModel = nextModel;
      context.controller.setProvider(config.defaultProvider, nextKey, nextModel);

      if (nextModel) {
        const { store } = await import("../../tui/src/store/ui-store");
        store.setSelectedModel(nextModel);
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

const approvalCommand: SlashCommand = {
  name: "approval",
  aliases: ["approve"],
  description: "Choose how much runs without asking",
  category: "configuration",

  async execute(context, args) {
    // The TUI intercepts this and opens the picker; reaching here means there is
    // no picker to open, so report the setting instead.
    const config = await getConfig();
    const info = describeApprovalMode(parseApprovalMode(config.approvalMode));

    const modes = APPROVAL_MODES.map((entry) => {
      const marker = entry.mode === info.mode ? "✓" : " ";
      const warning = entry.unsafe ? " (unsafe)" : "";
      return `  ${marker} ${entry.mode}${warning} — ${entry.description}`;
    }).join("\n");

    return `Approval mode: ${info.label}\n\n${modes}`;
  },
};

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
    const model = activeModel(context, config);

    return [
      `Workspace: ${repoName}`,
      `Path: ${cwd}`,
      `Branch: ${branch}`,
      ``,
      `Provider: ${providerLabel(provider)}`,
      `Model: ${getModelDisplayName(model)} (${model})`,
      ``,
      `Conversation: ${conversation.length} messages`,
      `Tools: ${toolRegistery.length} registered`,
      `Version: ${VERSION}`,
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
    return `Woopcode v${VERSION}`;
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
  registry.register(approvalCommand);
  registry.register(workspaceCommand);
  registry.register(statusCommand);
  registry.register(versionCommand);
}
