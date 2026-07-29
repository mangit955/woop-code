import { createProviderClient, DEFAULT_MODEL_ID } from "../config/client";
import {
  buildRepositoryContext,
  getConversation,
  saveConversation,
} from "../config/config";
import { agentLoop } from "../config/runtime";
import type { AgentCallbacks, Message } from "../config/types";
import { store } from "../tui/src";

/**
 * Keep casual conversation out of the coding-agent path. This is deliberately
 * narrow: anything that looks like a repository task still receives tools.
 */
export function isConversationalPrompt(prompt: string) {
  const text = prompt.trim().toLowerCase().replace(/\s+/g, " ");
  if (text.length === 0 || text.length > 160) return false;

  const workSignal = /\b(add|build|change|check|code|create|debug|delete|deploy|edit|error|explain|file|fix|implement|install|investigate|look at|project|read|refactor|remove|repo|run|test|update|write)\b/;
  if (workSignal.test(text)) return false;

  return /^(hi|hey|hello|yo|thanks|thank you|okay|ok|cool|great|nice|goodbye|bye|good morning|good afternoon|good evening)[!?. ]*$/.test(text)
    || /^(how are you|who are you|what can you do|what do you do|can you help me)[!?. ]*$/.test(text);
}

export class AgentController {
  private conversation: Message[] = [];
  private repoContext = "";
  private pendingAssistantText: string | null = null;
  private pendingUserMessage: Extract<Message, { role: "user" }> | null = null;
  private abortController: AbortController | null = null;
  private isRunning = false;
  private wasCancelled = false;
  private model: string;
  private readonly callbacks: AgentCallbacks;

  constructor(
    private provider: string,
    private apiKey: string,
    modelOrCallbacks: string | AgentCallbacks,
    callbacks?: AgentCallbacks,
  ) {
    this.model = typeof modelOrCallbacks === "string" ? modelOrCallbacks : DEFAULT_MODEL_ID;
    this.callbacks = typeof modelOrCallbacks === "string" ? callbacks! : modelOrCallbacks;
  }

  setModel(model: string) {
    if (this.isRunning) return false;
    this.model = model;
    return true;
  }

  /**
   * Switches the credentials used for the next turn. The provider client is
   * created per run, so changing them here is enough — without this, /provider
   * and /login only rewrite the config file while the session keeps talking to
   * the provider it started with.
   *
   * Returns false when a turn is in flight, so the caller can report that
   * instead of swapping credentials underneath a running request.
   */
  setProvider(provider: string, apiKey: string, model?: string) {
    if (this.isRunning) return false;
    this.provider = provider;
    this.apiKey = apiKey;
    if (model) this.model = model;
    return true;
  }

  getProvider() {
    return this.provider;
  }

  async run(prompt: string) {
    if (this.isRunning) {
      return;
    }

    // Reachable once /logout clears the active provider mid-session.
    if (!this.provider || !this.apiKey) {
      this.callbacks.onError?.(
        new Error("No provider is logged in. Use /login <provider> <api-key>."),
      );
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
    const conversational = isConversationalPrompt(prompt);
    this.pendingAssistantText = "";

    // Update UI before starting the agent
    store.addUserMessage(prompt);
    store.setStatus("Thinking...");

    let response = "";
    let agentLoopStarted = false;

    try {
      const client = createProviderClient(this.provider, this.apiKey, this.model);
      agentLoopStarted = true;
      response = await agentLoop(
        client,
        conversational ? [userMessage] : conversation,
        conversational ? "" : this.repoContext,
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
        !conversational,
      );

      const assistantText = response || this.pendingAssistantText;

      if (!this.wasCancelled && assistantText?.trim()) {
        this.conversation.push({
          role: "assistant",
          content: assistantText,
        });
      }
    } catch (error) {
      // agentLoop reports provider and tool failures itself. Client creation can
      // fail earlier (for example, when an unsupported provider is selected),
      // so surface that path to the UI as well.
      if (!agentLoopStarted) {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      throw error;
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
    // Tool calls can be waiting for a UI decision. Resolve those promises
    // before aborting so Ctrl+C never leaves the agent loop suspended.
    store.clearPendingEdit();
    store.clearPendingCommand();
    store.cancelPendingQuestion();
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
