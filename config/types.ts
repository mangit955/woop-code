export type ModelResponse =
  | {
      type: "message";
      content: string;
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      thoughtSignature?: string;
    };

export interface ProviderClient {
  stream(
    message: Message[],
    repoContext: string,
    signal?: AbortSignal,
    useTools?: boolean,
    /**
     * The tools to offer, defaulting to the whole registry.
     *
     * Passed by the loop so a turn can narrow it — plan mode sends the reading
     * tools only. Additive and last, so every existing caller and every fake
     * provider in the suite keeps working untouched.
     */
    tools?: readonly Tool[],
  ): AsyncGenerator<StreamEvent>;
}

/**
 * Token counts as reported by the provider for one request.
 *
 * These are the provider's own numbers, never an estimate. A provider that
 * does not report usage omits the field entirely rather than supplying a
 * guess, so a missing count is visibly missing instead of quietly wrong.
 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  /** Prompt tokens served from the provider's cache, when it reports them. */
  cachedTokens?: number;
  /**
   * Reasoning tokens, which the provider bills but does not return.
   *
   * Kept apart from `completionTokens`: the two are charged differently, and a
   * run that thinks at length while answering briefly is indistinguishable from
   * an idle one if only the answer is counted.
   */
  thoughtTokens?: number;
  totalTokens?: number;
}

/**
 * Sizes of the pieces the prompt is assembled from, in characters.
 *
 * Characters rather than tokens because the provider reports usage for the
 * request as a whole; a per-segment token split would need a separate
 * countTokens call per segment per iteration. Characters are exact and free,
 * and the ratios between them are what identify which segment is growing.
 * Absolute cost is the job of `usage`, which is measured.
 */
export interface PromptSegments {
  systemPrompt: number;
  repoContext: number;
  /**
   * The record of what this session already did; see runtime/executionLog.
   *
   * Measured apart from the repository context it is sent alongside, because
   * the two answer different questions: one is what the project is, the other
   * is what has been done to it, and only the second grows. Reported as 0 on a
   * headless run, where a process is a single turn and the log is always empty.
   */
  executionLog: number;
  /** Conversation messages: user and assistant text. */
  conversation: number;
  /** Tool calls and their results. */
  toolResults: number;
  /**
   * Per-turn instructions the mode adds, such as plan mode's rules.
   *
   * Optional because it is 0 for every ordinary turn, and stating it as optional
   * keeps the recorded segment literals in the replay corpus valid.
   */
  modeInstructions?: number;
}

/**
 * The non-conversational context a turn carries.
 *
 * A plain string is still accepted and means "repository context, no execution
 * log" — that is what every caller passed before the log existed, and what the
 * replay corpus reconstructs from recordings that predate it.
 */
export type TurnContext =
  | string
  | {
      repository: string;
      executionLog?: string;
      /**
       * Instructions for this turn only, sent ahead of the repository context.
       *
       * Plan mode's rules arrive here rather than in SYSTEM_PROMPT, so a Build
       * turn assembles byte-for-byte as it did before the mode existed.
       */
      instructions?: string;
    };

/**
 * What one turn did, recorded when the loop exits by any path.
 *
 * This is instrumentation, not policy: it records what happened and leaves the
 * judgement to whoever reads it. In particular `unverifiedEdits` counts any
 * shell command as verification, including one that verified nothing, because
 * over-counting verification under-reports the problem — the conservative
 * direction for a measurement whose whole purpose is to size it.
 */
export interface TurnSummary {
  iterations: number;
  /** Provider requests retried after a transient failure. */
  retries: number;
  /** Iterations whose stream died mid-response and was recovered, not lost. */
  salvagedIterations: number;
  /** Times the turn was asked to check its own edits before finishing. */
  verificationReminders: number;
  toolCalls: number;
  /**
   * Index of the last tool execution that changed the workspace, counting from
   * 1 across the turn. Absent when the turn changed nothing.
   */
  lastWriteStep?: number;
  /** Index of the last shell command — run_tests or run_terminal. */
  lastShellStep?: number;
  /** Executions per tool name, so analysis can separate tests from commands. */
  toolCounts: Record<string, number>;
  /** The turn changed files and ran no shell command afterwards. */
  unverifiedEdits: boolean;
}

/** What one pass through the agent loop cost. */
export interface IterationUsage {
  /** 1-based, matching the loop's own iteration counter. */
  iteration: number;
  usage?: TokenUsage;
  segments: PromptSegments;
  /** Tool calls the provider requested in this iteration. */
  toolCalls: number;
  durationMs: number;
}

export type Message =
  | {
      role: "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
    }
  | {
      role: "assistant_tool_call";
      toolName: string;
      toolCallId: string;
      arguments: Record<string, unknown>;
      thoughtSignature?: string;
      /**
       * Identifies the provider response this call arrived in.
       *
       * A model may return several calls in one response, and Gemini attaches a
       * thought signature only to the first of them. Sending them back as
       * separate model turns is rejected — the signature has to sit on the
       * first part of the turn that produced them — so the response they shared
       * has to survive being flattened into a message list.
       */
      batchId?: string;
    }
  | {
      role: "tool";
      toolName: string;
      toolCallId: string;
      content: string;
    };

export interface ToolParameter {
  name: string;
  description: string;
  required: boolean;
  type?: "string" | "number" | "boolean" | "array";
  /**
   * The properties of each object in an array parameter.
   *
   * Only meaningful with `type: "array"`, and optional: an array without it
   * holds strings, which is what every array parameter held before this existed.
   * Describing the properties is what lets a provider reject a bad value itself —
   * an `enum` here is enforced on their side, so an invalid status never costs a
   * round trip to discover.
   */
  items?: ToolItemProperty[];
}

/** One property of the objects in an array parameter. */
export interface ToolItemProperty {
  name: string;
  description: string;
  type?: "string" | "number" | "boolean";
  /** Allowed values, enforced by the provider. */
  enum?: string[];
  required?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * A step on the agent's own task list.
 *
 * Shared because three layers need the same shape: the tool that receives it,
 * the UI store that holds it, and the component that renders it.
 */
export type TodoStatus = "pending" | "in_progress" | "completed";

export const TODO_STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
];

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export interface ToolResult extends ToolCall {
  output: string;
}

export interface ToolFailure extends ToolCall {
  error: string;
}

/** What to do when a turn reaches its step ceiling. */
export type BudgetDecision = "continue" | "stop";

export interface AgentCallbacks {
  onStatus?(status: string): void;
  /**
   * The turn has used its whole budget and is not finished. Answering
   * `continue` grants another budget and carries the same turn on.
   *
   * Optional, and the absence is meaningful rather than a default: it means
   * nobody is there to ask, so the loop raises `IterationBudgetExhaustedError`
   * as it always has. Headless runs deliberately do not implement it, which is
   * what keeps their exit-code contract.
   */
  onBudgetExhausted?(info: { steps: number }): Promise<BudgetDecision>;
  /** Reported once per completed iteration, before the next one starts. */
  onUsage?(usage: IterationUsage): void;
  /** Reported exactly once when the turn ends, however it ends. */
  onTurnSummary?(summary: TurnSummary): void;
  /** A provider request failed transiently and is being tried again. */
  onRetry?(retry: {
    attempt: number;
    delayMs: number;
    reason: string;
    error: string;
  }): void;
  onText?(text: string): void;
  onToolStart?(tool: ToolCall): void;
  onToolFinish?(tool: ToolResult): void;
  onToolError?(tool: ToolFailure): void;
  /**
   * A tool was refused by policy and never ran.
   *
   * Distinct from `onToolError`, which means the tool ran and threw. Plan mode
   * refusing an edit is the mode working, not a fault, and reporting it as one
   * put a red row and a `failed:` line in front of the user every time the
   * feature did its job.
   */
  onToolBlocked?(tool: ToolFailure): void;
  onDone?(): void;
  onError?(error: Error): void;
  onCancel?(): void;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter[];

  /** The signal is aborted when the user cancels the active agent turn. */
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

export type StreamEvent =
  | { type: "text"; content: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      thoughtSignature?: string;
    }
  // Usage rides on the terminal event rather than arriving as a variant of its
  // own: every exhaustive switch over StreamEvent already handles `done`, and a
  // provider that reports nothing simply omits the field.
  | { type: "done"; usage?: TokenUsage }
  // A request failed transiently and is being tried again. Carried on the same
  // channel as everything else the provider says so the loop can surface it
  // without the client needing a callback of its own.
  | {
      type: "retry";
      /** 1-based count of attempts already made. */
      attempt: number;
      delayMs: number;
      reason: string;
      error: string;
    };
