import type { SlashCommand, SlashCommandContext } from "./types";
import { registry } from "./registry";
import { APPROVAL_MODES, describeApprovalMode, parseApprovalMode } from "../../runtime/approval";
import { getConfig, saveConfig } from "../../config/config";
import { listSessions, UNTITLED, type SessionSummary } from "../../config/sessions";
import { relativeTime } from "../../tui/src/relative-time";
import { isProviderEnabled, unsupportedProviderMessage } from "../../providers/providerRegistry";
import { DEFAULT_MODEL_ID, getModelDisplayName } from "../../providers/client";
import { toolRegistry } from "../../tools";
import { VERSION } from "../../config/version";
// The catalog owns the shape of models.json and the join with providerRegistry,
// so the CLI command and this slash command cannot describe a model differently.
import {
  allModels,
  defaultModelForProvider,
  modelBelongsToProvider,
  providerLabel,
} from "../../providers/modelCatalog";

const models = allModels();

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

/**
 * Keeps the selected model consistent with the provider. Returns a model id
 * when the current selection belongs to a different provider, and undefined
 * when the user's choice is still valid (or the provider lists no models).
 */
function modelForProvider(provider: string, currentModel: string | undefined) {
  if (modelBelongsToProvider(currentModel, provider)) return undefined;

  // The catalog decides which model a provider starts on — the same answer
  // createProviderClient reaches for when a stored selection turns out to
  // belong elsewhere, so switching provider here and running a turn cannot
  // disagree about the model.
  return defaultModelForProvider(provider);
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

/** A picker row rendered as one line of text, for /sessions and errors. */
function describeSession(session: SessionSummary, active = false): string {
  const label = session.name ?? session.title ?? UNTITLED;
  const marker = active ? "●" : " ";
  const parts = [
    `${marker} ${session.id.slice(0, 8)}`,
    label,
    relativeTime(session.updated),
    `${session.messageCount} msg`,
  ];
  if (session.branch) parts.push(session.branch);
  return parts.join("  ·  ");
}

const newCommand: SlashCommand = {
  name: "new",
  aliases: ["clear", "reset"],
  description: "Start a new conversation, keeping the current one",
  category: "session",

  async execute(context, args) {
    if (context.controller.isBusy()) {
      return "Cannot start a new session while the agent is running. Press Esc to cancel first.";
    }

    const previous = context.controller.currentSession();
    const session = await context.controller.newSession();
    if (!session) return "Could not start a new session.";

    const { store } = await import("../../tui/src/store/ui-store");
    store.clearTimeline();

    // Naming the way back is the whole difference from what /new used to do.
    return previous && previous.messages.length > 0
      ? `Started a new session. The previous one is saved as ${previous.id.slice(0, 8)} — /resume ${previous.id.slice(0, 8)} to return.`
      : "Started a new session";
  },
};

const resumeCommand: SlashCommand = {
  name: "resume",
  aliases: ["r"],
  description: "Switch to a previous conversation",
  category: "session",
  usage: "/resume [name-or-id]",

  async execute(context, args) {
    if (context.controller.isBusy()) {
      return "Cannot switch sessions while the agent is running. Press Esc to cancel first.";
    }

    const { store } = await import("../../tui/src/store/ui-store");

    if (args.length === 0) {
      store.openSessionPicker();
      return "";
    }

    const ref = args.join(" ");
    let session;
    try {
      session = await context.controller.switchSession(ref);
    } catch (error) {
      // Ambiguity is reported rather than guessed at; the message names the way
      // to disambiguate.
      return error instanceof Error ? error.message : String(error);
    }

    if (!session) {
      return `No session found matching "${ref}". Use /resume with no argument to pick from a list.`;
    }

    store.hydrateTimeline(session.messages);
    return `Resumed ${session.name ?? session.title}`;
  },
};

const listSessionsCommand: SlashCommand = {
  name: "sessions",
  aliases: ["ls"],
  description: "List saved conversations for this project",
  category: "session",

  async execute(context, args) {
    const sessions = await listSessions();
    if (sessions.length === 0) return "No saved sessions in this project yet.";

    const activeId = context.controller.currentSession()?.id;
    const rows = sessions
      .slice(0, 20)
      .map((session) => describeSession(session, session.id === activeId));

    return [
      `Sessions in this project (${sessions.length}):`,
      "",
      ...rows,
      "",
      "Switch with /resume <name-or-id>",
    ].join("\n");
  },
};

const renameCommand: SlashCommand = {
  name: "rename",
  description: "Name the current conversation so it can be resumed by name",
  category: "session",
  usage: "/rename <name>",

  async execute(context, args) {
    if (args.length === 0) return "Usage: /rename <name>";
    if (context.controller.isBusy()) {
      return "Cannot rename while the agent is running. Press Esc to cancel first.";
    }

    const session = await context.controller.renameSession(args.join(" "));
    if (!session) return "No session to rename yet — run a turn first.";

    return `Renamed to ${session.name}`;
  },
};

const branchCommand: SlashCommand = {
  name: "branch",
  aliases: ["fork"],
  description: "Copy this conversation and continue in the copy",
  category: "session",
  usage: "/branch [name]",

  async execute(context, args) {
    if (context.controller.isBusy()) {
      return "Cannot branch while the agent is running. Press Esc to cancel first.";
    }

    const original = context.controller.currentSession();
    if (!original || original.messages.length === 0) {
      return "Nothing to branch yet — run a turn first.";
    }

    const session = await context.controller.branchSession(args.join(" ") || undefined);
    if (!session) return "Could not branch this session.";

    return [
      `Branched into ${session.name ?? session.title} (${session.id.slice(0, 8)}).`,
      `The original is unchanged — /resume ${original.id.slice(0, 8)} to return to it.`,
    ].join("\n");
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

    const { loginProvider } = await import("../../config/authProvider");
    const isValid = await loginProvider(provider, apiKey);

    if (!isValid) {
      return `Invalid API key for ${provider}.\nPlease check your API key and try again.`;
    }

    if (context.controller.isBusy()) {
      return `Cannot change provider while the agent is running. Press Esc to cancel first.`;
    }

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

    delete config.providers[provider].apiKey;

    // Leaving a logged-out provider as the default would send the next turn at
    // a provider with no key, so hand the default to one that still has one.
    if (config.defaultProvider === provider) {
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
    // Optional the same way getModel is below: /status is the command someone
    // runs when something is wrong, so it reports what it can rather than
    // throwing on a controller that is not fully wired.
    const session = context.controller?.currentSession?.() ?? null;
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
      `Session: ${session ? `${session.name ?? session.title} (${session.id.slice(0, 8)})` : "none yet"}`,
      `Conversation: ${context.controller?.messageCount?.() ?? 0} messages`,
      `Tools: ${toolRegistry.length} registered`,
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
  registry.register(resumeCommand);
  registry.register(listSessionsCommand);
  registry.register(renameCommand);
  registry.register(branchCommand);
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
