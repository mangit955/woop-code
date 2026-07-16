console.log("hello");
//TODO: remove this hello log
import { getTool } from "../tools";
import type { Message, ProviderClient } from "./types";

export async function agentLoop(
  client: ProviderClient,
  messages: Message[],
  repoContext: string,
) {
  const MAX_ITERATIONS = 10;
  const executedTools = new Set<string>();
  let iterations = 0;
  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log("➡️ Calling model...");
    const response = await client.generate(messages, repoContext);
    console.log("📨 Model response:", response);

    if (response.type === "message") {
      return response.content;
    }

    console.log(`🔨 Tool requested: ${response.name}`);
    const tool = getTool(response.name);

    if (!tool) {
      throw new Error(`Unknown tool: ${response.name}`);
    }

    const toolKey = `${response.name}:${JSON.stringify(response.arguments)}`;

    if (executedTools.has(toolKey)) {
      throw new Error("Tool loop detected");
    }

    executedTools.add(toolKey);

    // Record the model's tool request so provider clients can serialize it if needed.
    messages.push({
      role: "assistant_tool_call",
      toolName: response.name,
      toolCallId: response.id,
      arguments: response.arguments,
    });

    const result = await tool.execute(response.arguments);
    const MAX_TOOL_RESULT = 4000;
    const toolResult =
      result.length > MAX_TOOL_RESULT
        ? result.slice(0, MAX_TOOL_RESULT) + "\n\n...output truncated..."
        : result;
    console.log("✅ Tool execution completed");
    console.log("📄 Tool result:", result);

    // Append the tool response so the model can continue reasoning.
    messages.push({
      role: "tool",
      toolName: response.name,
      toolCallId: response.id,
      content: toolResult,
    } as Message);

    console.log(
      "🔁 Tool result appended to conversation. Asking model again...",
    );
  }
  throw new Error(
    `Agent exceeded the maximum number of iterations (${MAX_ITERATIONS}).`,
  );
}
