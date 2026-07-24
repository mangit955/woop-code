import type { Message, StreamEvent, ToolCall } from "../../../config/types";

/**
 * Factory for creating test messages
 */
export const createUserMessage = (content: string): Message => ({
  role: "user",
  content,
});

export const createAssistantMessage = (content: string): Message => ({
  role: "assistant",
  content,
});

export const createAssistantToolCallMessage = (
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
  thoughtSignature?: string,
): Message => ({
  role: "assistant_tool_call",
  toolName,
  toolCallId,
  arguments: args,
  thoughtSignature,
});

export const createToolMessage = (
  toolName: string,
  toolCallId: string,
  content: string,
): Message => ({
  role: "tool",
  toolName,
  toolCallId,
  content,
});

/**
 * Factory for creating stream events
 */
export const createTextEvent = (content: string): StreamEvent => ({
  type: "text",
  content,
});

export const createToolCallEvent = (
  name: string,
  args: Record<string, unknown>,
  id: string = "test-tool-call-id",
  thoughtSignature?: string,
): StreamEvent => ({
  type: "tool_call",
  id,
  name,
  arguments: args,
  thoughtSignature,
});

export const createDoneEvent = (): StreamEvent => ({
  type: "done",
});

/**
 * Factory for creating tool calls
 */
export const createToolCall = (
  name: string,
  args: Record<string, unknown>,
  id: string = "test-tool-call-id",
): ToolCall => ({
  id,
  name,
  arguments: args,
});

/**
 * Helper to generate large text for truncation tests
 */
export const generateLargeText = (sizeInChars: number): string => {
  return "x".repeat(sizeInChars);
};

/**
 * Helper to create a sequence of text events
 */
export const createTextStreamSequence = (texts: string[]): StreamEvent[] => {
  return [...texts.map(createTextEvent), createDoneEvent()];
};
