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

export const agentCommand = new Command("agent")
  .description("Runs the agent")
  .option("-p, --prompt <prompt>", "prompt", "")
  .action(async (options) => {
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
        store.setStatus(status);
      },

      onToolStart(tool) {
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
    };
    const controller = new AgentController(provider, apiKey, callbacks);
    render(<App controller={controller} />);
  });
