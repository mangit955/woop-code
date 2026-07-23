import { createProviderClient } from "../config/client";
import {
  buildRepositoryContext,
  getConversation,
  saveConversation,
} from "../config/config";
import { agentLoop } from "../config/runtime";
import type { AgentCallbacks, Message } from "../config/types";
import { store } from "../tui/src";

export class AgentController {
  constructor(
    private readonly provider: string,
    private readonly apiKey: string,
    private readonly callbacks: AgentCallbacks,
  ) {}

  async run(prompt: string) {
    const messages = await getConversation();
    const conversation: Message[] = [...messages];

    const repoContext = await buildRepositoryContext();

    conversation.push({
      role: "user",
      content: prompt,
    });

    // Update UI before starting the agent
    store.addUserMessage(prompt);
    store.startAssistantMessage();
    store.setStatus("Thinking...");

    const client = createProviderClient(this.provider, this.apiKey);

    const response = await agentLoop(
      client,
      conversation,
      repoContext,
      this.callbacks,
    );

    messages.push(
      {
        role: "user",
        content: prompt,
      },
      {
        role: "assistant",
        content: response,
      },
    );

    await saveConversation(messages);

    return response;
  }
}
