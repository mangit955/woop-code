import { getTool } from "../tools";
import { recentMessages } from "./config";
import type { Message, ProviderClient, StreamEvent } from "./types";

export async function agentLoop(
  client: ProviderClient,
  messages: Message[],
  repoContext: string,
) {
  const MAX_ITERATIONS = 10;
  const MAX_TURNS = 8;
  const executedTools = new Set<string>();
  let iterations = 0;
  while (iterations < MAX_ITERATIONS) {
    iterations++;

    let assistantText = "";
    let toolCall: Extract<StreamEvent, { type: "tool_call" }> | null = null;

    for await (const event of client.stream(
      recentMessages(messages, MAX_TURNS),
      repoContext,
    )) {
      switch (event.type) {
        case "text":
          process.stdout.write(event.content);
          assistantText += event.content;
          break;

        case "tool_call":
          toolCall = event;
          break;

        case "done":
          break;
      }
    }
    console.log();

    if (!toolCall) {
      messages.push({
        role: "assistant",
        content: assistantText,
      });

      return assistantText;
    }

    const tool = getTool(toolCall.name);

    if (!tool) {
      throw new Error(`Unknown tool: ${toolCall.name}`);
    }

    const toolKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;

    if (executedTools.has(toolKey)) {
      throw new Error("Tool loop detected");
    }

    executedTools.add(toolKey);

    // Record the model's tool request so provider clients can serialize it if needed.
    messages.push({
      role: "assistant_tool_call",
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      arguments: toolCall.arguments,
      thoughtSignature: toolCall.thoughtSignature,
    });

    const result = await tool.execute(toolCall.arguments);
    const MAX_TOOL_RESULT = 4000;
    const toolResult =
      result.length > MAX_TOOL_RESULT
        ? result.slice(0, MAX_TOOL_RESULT) + "\n\n...output truncated..."
        : result;

    // Append the tool response so the model can continue reasoning.
    messages.push({
      role: "tool",
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      content: toolResult,
    } as Message);
  }
  throw new Error(
    `Agent exceeded the maximum number of iterations (${MAX_ITERATIONS}).`,
  );
}
