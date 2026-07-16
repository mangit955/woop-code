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
    };

export interface ProviderClient {
  generate(message: Message[], repoContext: string): Promise<ModelResponse>;
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
