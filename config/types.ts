export type ModelResponse =
  | {
      type: "message";
      content: string;
    }
  | {
      type: "tool_call";
      name: string;
      arguments: Record<string, unknown>;
    };

export interface ProviderClient {
  generate(message: Message[]): Promise<ModelResponse>;
}

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export interface ToolParameter {
  name: string;
  description: string;
  required: boolean;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter[];

  execute(args: Record<string, unknown>): Promise<string>;
}
