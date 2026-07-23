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
  private pendingUserMessage: Extract<Message, { role: "user" }> | null = null;
  private abortController: AbortController | null = null;
  private isRunning = false;
  private wasCancelled = false;

  constructor(
    private readonly provider: string,
    private readonly apiKey: string,
    private readonly callbacks: AgentCallbacks,
  ) {}

  async run(prompt: string) {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    this.wasCancelled = false;

    const userMessage: Extract<Message, { role: "user" }> = {
      role: "user",
      content: prompt,
    };

    this.conversation.push(userMessage);
    this.pendingUserMessage = userMessage;

    const conversation = [...this.conversation];
    this.pendingAssistantText = "";

    // Update UI before starting the agent
    store.addUserMessage(prompt);
    store.setStatus("Thinking...");

    const client = createProviderClient(this.provider, this.apiKey);

    let response = "";

    try {
      response = await agentLoop(
        client,
        conversation,
        this.repoContext,
        {
          ...this.callbacks,
          onText: (text) => {
            this.pendingAssistantText += text;
            this.callbacks.onText?.(text);
          },
          onCancel: () => {
            this.wasCancelled = true;
            this.callbacks.onCancel?.();
          },
        },
        this.abortController.signal,
      );

      const assistantText = response || this.pendingAssistantText;

      if (!this.wasCancelled && assistantText?.trim()) {
        this.conversation.push({
          role: "assistant",
          content: assistantText,
        });
      }
    } finally {
      this.abortController = null;
      this.isRunning = false;
    }
    this.pendingAssistantText = null;
    if (this.wasCancelled) {
      this.removePendingUserMessage();
    } else {
      this.pendingUserMessage = null;
    }

    return response;
  }

  async initialize() {
    this.conversation = await getConversation();
    this.repoContext = await buildRepositoryContext();
  }

  async dispose() {
    if (this.wasCancelled) {
      this.pendingAssistantText = null;
      this.removePendingUserMessage();
    } else if (this.pendingAssistantText?.trim()) {
      this.conversation.push({
        role: "assistant",
        content: this.pendingAssistantText,
      });
      this.pendingAssistantText = null;
    }

    await saveConversation(this.conversation);
  }

  cancel() {
    if (!this.isRunning) {
      return;
    }

    this.wasCancelled = true;
    this.abortController?.abort();
  }

  isBusy() {
    return this.isRunning;
  }

  private removePendingUserMessage() {
    if (!this.pendingUserMessage) {
      return;
    }

    this.conversation = this.conversation.filter(
      (message) => message !== this.pendingUserMessage,
    );
    this.pendingUserMessage = null;
  }
}
