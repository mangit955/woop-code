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
  private conversation: Message[] = [];
  private repoContext = "";
  private pendingAssistantText: string | null = null;

  constructor(
    private readonly provider: string,
    private readonly apiKey: string,
    private readonly callbacks: AgentCallbacks,
  ) {}

  async run(prompt: string) {
    this.conversation.push({
      role: "user",
      content: prompt,
    });

    const conversation = [...this.conversation];
    this.pendingAssistantText = "";

    // Update UI before starting the agent
    store.addUserMessage(prompt);
    store.startAssistantMessage();
    store.setStatus("Thinking...");

    const client = createProviderClient(this.provider, this.apiKey);

    const response = await agentLoop(
      client,
      conversation,
      this.repoContext,
      {
        ...this.callbacks,
        onText: (text) => {
          this.pendingAssistantText += text;
          this.callbacks.onText?.(text);
        },
      },
    );

    this.conversation.push({
      role: "assistant",
      content: response,
    });
    this.pendingAssistantText = null;

    return response;
  }

  async initialize() {
    this.conversation = await getConversation();
    this.repoContext = await buildRepositoryContext();
  }

  async dispose() {
    if (this.pendingAssistantText) {
      this.conversation.push({
        role: "assistant",
        content: this.pendingAssistantText,
      });
      this.pendingAssistantText = null;
    }

    await saveConversation(this.conversation);
  }
}
