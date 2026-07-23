import { Command } from "commander";
import {
  buildRepositoryContext,
  getConfig,
  getConversation,
  saveConversation,
} from "../config/config";
import { createProviderClient } from "../config/client";
import type { Message } from "../config/types";
import type { AgentCallbacks } from "../config/types";
import { agentLoop } from "../config/runtime";
import { App, store } from "../tui/src";
import { render } from "ink";
import { AgentController } from "./agentController";
import { ACTIVE_PROVIDER_MODELS } from "../config/client";
import type { HomeScreenData } from "../tui/src/components/HomeScreen";

export const agentCommand = new Command("agent")
  .description("Runs the agent")
  .option("-p, --prompt <prompt>", "prompt", "")
  .action(runAgent);

/** Runs the interactive agent from either `woopcode` or `woopcode agent`. */
export async function runAgent() {
  let cancelStatusTimeout: ReturnType<typeof setTimeout> | undefined;
  const config = await getConfig();
  const provider = config.defaultProvider;
  const apiKey = config.providers[provider].apiKey;

  if (!provider || !apiKey) {
    console.error(
      "No provider is configured run woopcode provider --login first",
    );
    return;
  }

  const callbacks: AgentCallbacks = {
      onStatus(status) {
        if (cancelStatusTimeout) {
          clearTimeout(cancelStatusTimeout);
          cancelStatusTimeout = undefined;
        }
        store.setStatus(status);
      },

      onToolStart(tool) {
        store.finishAssistantMessage();
        store.startTool(tool);
        store.setStatus(`Running ${tool.name}...`);
      },

      onToolFinish(tool) {
        store.finishTool(tool.id);
        store.setStatus("Thinking...");
      },

      onText(text) {
        store.appendAssistantText(text);
      },

      onDone() {
        //console.log("onDone received");
        store.finishAssistantMessage();
        store.setStatus("Ready");
      },

      onError(error) {
        store.finishAssistantMessage();
        store.setStatus(`Error: ${error.message}`);
      },

      onCancel() {
        store.finishAssistantMessage();
        store.setStatus("Cancelled");

        cancelStatusTimeout = setTimeout(() => {
          store.setStatus("Ready");
        }, 1000);
      },
  };
  const controller = new AgentController(provider, apiKey, callbacks);
  await controller.initialize();
  const homeScreen = await buildHomeScreen(provider);

  const { unmount } = render(
    <App controller={controller} onExit={handleExit} homeScreen={homeScreen} />,
    { exitOnCtrlC: false },
  );

  let exiting = false;

  async function handleExit() {
    if (exiting) return;
    exiting = true;

    controller.cancel();
    await controller.dispose();
    unmount();
    process.exit(0);
  }

  process.once("SIGINT", () => {
    void handleExit();
  });
}

async function buildHomeScreen(provider: string): Promise<HomeScreenData> {
  const repository = process.cwd().split("/").filter(Boolean).at(-1) ?? "workspace";
  const branch = await getBranch();
  const providerLabel = provider === "google" ? "Gemini" : titleCase(provider);

  return {
    logoWord: "WOOPCODE",
    subtitle: "AI software engineering agent",
    promptExamples: [
      "Explain this repository",
      "Review recent changes",
      "Find duplicate code",
      "Generate tests",
      "Optimize performance",
      "Add authentication",
    ],
    capabilities: ["Build", "Review", "Explain", "Refactor", "Debug", "Test", "Document"],
    repository,
    branch,
    providerName: providerLabel,
    provider: ACTIVE_PROVIDER_MODELS[provider] ?? providerLabel,
  };
}

async function getBranch(): Promise<string> {
  try {
    const branch = (await Bun.$`git branch --show-current`.text()).trim();
    return branch || "detached";
  } catch {
    return "not a git repository";
  }
}

function titleCase(value: string) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
