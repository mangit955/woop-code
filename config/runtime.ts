import { getTool } from "../tools";
import { recentMessages } from "./config";
import type {
  AgentCallbacks,
  Message,
  ProviderClient,
  StreamEvent,
} from "./types";

// console.time("first-token");
export async function agentLoop(
  client: ProviderClient,
  messages: Message[],
  repoContext: string,
  callbacks: AgentCallbacks,
) {
  const MAX_ITERATIONS = 10;
  const MAX_TURNS = 8;
  const executedTools = new Set<string>();

  let iterations = 0;

  try {
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
            assistantText += event.content;
            callbacks.onText?.(event.content);
            break;

          case "tool_call":
            toolCall = event;
            break;

          case "done":
            break;
        }
      }

      if (!toolCall) {
        messages.push({
          role: "assistant",
          content: assistantText,
        });

        callbacks.onDone?.();
        //console.log("onDone emitted");

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
      callbacks.onToolStart?.({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      });

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

      callbacks.onToolFinish?.({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
        output: toolResult,
      });

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
  } catch (error) {
    const agentError =
      error instanceof Error ? error : new Error(String(error));

    callbacks.onError?.(agentError);
    throw agentError;
  }
}
