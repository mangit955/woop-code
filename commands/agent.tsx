import { Command } from "commander";
import {
  buildRepositoryContext,
  getConfig,
  getConversation,
  saveConversation,
} from "../config/config";
import { createProviderClient } from "../config/client";
import type { Message } from "../config/types";
import { agentLoop } from "../config/runtime";
import { App, store } from "../tui/src";
import { render } from "ink";

export const agentCommand = new Command("agent")
  .description("Runs the agent")
  .option("-p, --prompt <prompt>", "prompt", "")
  .action(async (options) => {
    const { unmount } = render(<App />);
    const config = await getConfig();
    const provider = config.defaultProvider;
    const apiKey = config.providers[provider].apiKey;
    const callbacks = {
      onText(text: string) {
        store.appendAssistantText(text);
      },
    };

    if (!provider || !apiKey) {
      console.error(
        "No provider is configured run woopcode provider --login first",
      );
      return;
    }

    const messages: Message[] = await getConversation();
    const conversation: Message[] = [...messages];
    //console.time("buildRepositoryContext");
    const repoContext = await buildRepositoryContext();
    //console.timeEnd("buildRepositoryContext");

    conversation.push({
      role: "user",
      content: options.prompt,
    });

    async function runAgent(requestMessages: Message[], repoContext: string) {
      const client = createProviderClient(provider, apiKey);

      return agentLoop(client, requestMessages, repoContext, callbacks);
    }

    //console.time("agentLoop");
    store.addUserMessage(options.prompt);
    store.startAssistantMessage();
    store.setStatus("Thinking...");

    const response = await runAgent(conversation, repoContext);

    store.finishAssistantMessage();
    store.setStatus("Ready");
    //console.timeEnd("agentLoop");

    messages.push(
      {
        role: "user",
        content: options.prompt,
      },
      {
        role: "assistant",
        content: response,
      },
    );

    await saveConversation(messages);
  });
