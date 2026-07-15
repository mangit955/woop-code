import { getTool } from "../tools";
import type { Message, ProviderClient } from "./types";

export async function agentLoop(client: ProviderClient, messages: Message[]) {
  while (true) {
    console.log("➡️ Calling model...");
    const response = await client.generate(messages);
    console.log("📨 Model response:", response);

    if (response.type === "message") {
      return response.content;
    }

    console.log(`🔨 Tool requested: ${response.name}`);
    const tool = getTool(response.name);

    if (!tool) {
      throw new Error(`Unknown tool: ${response.name}`);
    }

    const result = await tool.execute(response.arguments);
    console.log("✅ Tool execution completed");
    console.log("📄 Tool result:", result);

    messages.push({
      role: "assistant",
      content: `Calling tool: ${response.name}`,
    } as Message);

    messages.push({
      role: "tool",
      content: result,
    } as Message);
    console.log(
      "🔁 Tool result appended to conversation. Asking model again...",
    );
  }
}
