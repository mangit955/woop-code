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
  /** Conversation messages: user and assistant text. */
  conversation: number;
  /** Tool calls and their results. */
  toolResults: number;
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
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult extends ToolCall {
  output: string;
}

export interface ToolFailure extends ToolCall {
  error: string;
}

export interface AgentCallbacks {
  onStatus?(status: string): void;
  /** Reported once per completed iteration, before the next one starts. */
  onUsage?(usage: IterationUsage): void;
  onText?(text: string): void;
  onToolStart?(tool: ToolCall): void;
  onToolFinish?(tool: ToolResult): void;
  onToolError?(tool: ToolFailure): void;
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
  | { type: "done"; usage?: TokenUsage };
