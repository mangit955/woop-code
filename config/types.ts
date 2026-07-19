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
  stream(message: Message[], repoContext: string): AsyncGenerator<StreamEvent>;
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
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter[];

  execute(args: Record<string, unknown>): Promise<string>;
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
  | { type: "done" };
