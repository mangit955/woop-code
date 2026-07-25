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
  const MAX_ITERATIONS = 20; // Reduced for free tier efficiency
  const MAX_TURNS = 6; // Reduced from 8 to limit context/token usage
  const SAME_TOOL_THRESHOLD = 2; // Strict - prevent wasteful repeats
  const executedTools = new Map<string, number>(); // Track count instead of just presence

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

      // Allow some tools to be called multiple times (like read_file after edit_file)
      // But block obvious loops where the same tool is called 3+ times with identical args
      if (callCount >= SAME_TOOL_THRESHOLD) {
        throw new Error(
          `Tool loop detected: ${toolCall.name} called ${callCount + 1} times with identical arguments. ` +
          `This usually indicates the tool result is being ignored or the task cannot be completed.`
        );
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
