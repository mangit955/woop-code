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

    const messages: Message[] = await getConversation();
    const conversation: Message[] = [...messages];
    const repoContext = await buildRepositoryContext();

    conversation.push({
      role: "user",
      content: options.prompt,
    });

    const requestMessages: Message[] = conversation;

    const client = createProviderClient(provider, apiKey);

    const response = await agentLoop(client, requestMessages, repoContext);

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
