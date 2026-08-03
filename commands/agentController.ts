import { createProviderClient, DEFAULT_MODEL_ID } from "../config/client";
import {
  MAX_REPO_CONTEXT_CHARS,
  buildRepositoryContext,
  getConversation,
  getExecutionLog,
  saveConversation,
  saveExecutionLog,
} from "../config/config";
import { agentLoop } from "../config/runtime";
import {
  EXECUTION_LOG_BUDGET_RATIO,
  recordsFrom,
  renderExecutionLog,
  type ExecutionRecord,
} from "../runtime/executionLog";
import type { AgentCallbacks, Message, TurnContext } from "../config/types";
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
  /** One line per action this session has taken; see runtime/executionLog. */
  private executionRecords: ExecutionRecord[] = [];
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

  getModel() {
    return this.model;
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

    // The loop appends this turn's tool calls and results to `conversation`,
    // which is a copy — everything it records is discarded on return. Note
    // where this turn's records start so they can be harvested before that
    // happens, rather than threading new plumbing through the loop.
    const recordsBefore = conversation.length;

    // Update UI before starting the agent
    store.addUserMessage(prompt);
    // Opened here rather than after the first token so the footer appears
    // directly under the prompt the moment the turn starts, then travels down
    // as the turn appends tool rows and assistant text beneath it.
    store.startTurn({
      agent: "Build",
      model: this.model,
      startedAt: Date.now(),
    });
    store.setStatus("Thinking...");

    let response = "";
    let agentLoopStarted = false;
    let failed = false;

    try {
      const client = createProviderClient(this.provider, this.apiKey, this.model);
      agentLoopStarted = true;
      response = await agentLoop(
        client,
        conversational ? [userMessage] : conversation,
        conversational ? "" : this.contextForTurn(),
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
      failed = true;
      await this.persist();
      throw error;
    } finally {
      // In the finally so every path harvests exactly once. A turn that failed
      // or was cancelled still did work before it stopped, and that work is
      // precisely what the next turn must not repeat.
      this.harvestExecutionRecords(conversation, recordsBefore);
      this.abortController = null;
      this.isRunning = false;
      store.finishTurn(
        this.wasCancelled ? "cancelled" : failed ? "error" : "completed",
      );
    }
    this.pendingAssistantText = null;
    if (this.wasCancelled) {
      this.removePendingUserMessage();
    } else {
      this.pendingUserMessage = null;
    }

    // Persist per turn rather than only on disposal: a crash, a killed
    // terminal or a machine losing power would otherwise discard the whole
    // session, and there is nothing else that would have written it.
    await this.persist();

    return response;
  }

  async initialize() {
    this.conversation = await getConversation();
    this.executionRecords = await getExecutionLog();
    this.repoContext = await buildRepositoryContext();
  }

  /**
   * Keeps a one-line record of everything the turn did, before the loop's copy
   * of the conversation goes out of scope and takes the tool history with it.
   *
   * A failed or cancelled turn is harvested too: work it completed before
   * stopping is exactly what the next turn must not redo.
   */
  private harvestExecutionRecords(conversation: Message[], from: number) {
    const fresh = recordsFrom(
      conversation.slice(from),
      this.executionRecords.length + 1,
    );
    if (fresh.length === 0) return;

    this.executionRecords.push(...fresh);

    // Bounded here as well as at render time so a long session cannot grow the
    // array without limit; the render budget decides what is actually sent.
    const MAX_RETAINED = 200;
    if (this.executionRecords.length > MAX_RETAINED) {
      this.executionRecords = this.executionRecords.slice(-MAX_RETAINED);
    }
  }

  /**
   * The repository context and what this session has already done, kept apart.
   *
   * They were previously joined here and sent as one string, which made them
   * indistinguishable to the meter: the log was reported as repository context,
   * so nothing could say how much of a request was which. The loop joins them
   * now, and measures them separately.
   */
  private contextForTurn(): TurnContext {
    const budget = Math.floor(
      MAX_REPO_CONTEXT_CHARS * EXECUTION_LOG_BUDGET_RATIO,
    );

    return {
      repository: this.repoContext,
      executionLog: renderExecutionLog(this.executionRecords, budget),
    };
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

    await this.persist();
  }

  /**
   * Writes the conversation to disk. Failures are reported but never thrown:
   * losing history is bad, but it must not take down a turn that otherwise
   * succeeded.
   */
  private async persist() {
    try {
      await saveConversation(this.conversation);
      await saveExecutionLog(this.executionRecords);
    } catch (error) {
      this.callbacks.onError?.(
        new Error(
          `Could not save conversation history: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
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
