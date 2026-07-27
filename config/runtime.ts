import { getTool } from "../tools";
import { recentMessages } from "./config";
import type {
  AgentCallbacks,
  Message,
  ProviderClient,
  StreamEvent,
} from "./types";

export async function agentLoop(
  client: ProviderClient,
  messages: Message[],
  repoContext: string,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
) {
  const MAX_ITERATIONS = 20; // Allow complex tasks to complete
  const MAX_TURNS = 6; // Reduced from 8 to limit context/token usage
  const SAME_TOOL_THRESHOLD = 4;
  
  const executedTools = new Map<string, number>();

  let iterations = 0;

  try {
    while (iterations < MAX_ITERATIONS) {
      iterations++;
      
      // Warn the agent about efficiency at key milestones
      if (iterations === 6) {
        callbacks.onStatus?.(`⚠️  ${iterations} tools used - start implementing now to conserve quota`);
      } else if (iterations === MAX_ITERATIONS - 5) {
        callbacks.onStatus?.(`⚠️  ${MAX_ITERATIONS - iterations} iterations remaining - prioritize completion`);
      }

      let assistantText = "";
      let toolCall: Extract<StreamEvent, { type: "tool_call" }> | null = null;

      for await (const event of client.stream(
        recentMessages(messages, MAX_TURNS),
        repoContext,
        signal,
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

      if (signal?.aborted) {
        callbacks.onCancel?.();
        return "";
      }

      if (!toolCall) {
        messages.push({
          role: "assistant",
          content: assistantText,
        });

        callbacks.onDone?.();

        return assistantText;
      }

      const tool = getTool(toolCall.name);

      if (!tool) {
        throw new Error(`Unknown tool: ${toolCall.name}`);
      }

      // Create normalized key for better duplicate detection
      let toolKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
      
      // Special handling for terminal commands - normalize to catch duplicates
      if (toolCall.name === "run_terminal" && toolCall.arguments.command) {
        const cmd = String(toolCall.arguments.command).trim();
        // Normalize: remove "cd X &&", normalize package managers, trim whitespace
        const normalizedCmd = cmd
          .replace(/^cd\s+\S+\s+&&\s+/, "") // remove cd prefix
          .replace(/bun (add|install)/, "install") // normalize bun
          .replace(/npm (i|install)/, "install") // normalize npm
          .replace(/\s+/g, " ") // normalize whitespace
          .trim();
        toolKey = `run_terminal:${normalizedCmd}`;
      }

      const callCount = executedTools.get(toolKey) || 0;

      // A model may legitimately re-read a file while it plans an edit. After
      // several identical calls, avoid wasted work but leave it enough context
      // to choose a different next step instead of aborting the whole task.
      if (callCount >= SAME_TOOL_THRESHOLD) {
        const output =
          `Skipped duplicate ${toolCall.name} call. The result for these exact arguments ` +
          `is already in the conversation; use it and continue with a different action.`;

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
        callbacks.onToolFinish?.({
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          output,
        });
        messages.push({
          role: "tool",
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          content: output,
        });
        continue;
      }

      executedTools.set(toolKey, callCount + 1);
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

      let result: string;
      try {
        result = await tool.execute(toolCall.arguments);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        callbacks.onToolError?.({
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          error: message,
        });
        messages.push({
          role: "tool",
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          content: `Tool failed: ${message}`,
        });
        continue;
      }
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
      `Agent exceeded the maximum number of iterations (${MAX_ITERATIONS}).\n\n` +
      `This usually means:\n` +
      `  • The task is too complex - try breaking it into smaller steps\n` +
      `  • The agent is stuck in analysis - it may need clearer instructions\n` +
      `  • More iterations are needed - consider increasing MAX_ITERATIONS`
    );
  } catch (error) {
    if (signal?.aborted) {
      callbacks.onCancel?.();
      return "";
    }

    const agentError =
      error instanceof Error ? error : new Error(String(error));

    callbacks.onError?.(agentError);
    throw agentError;
  }
}
