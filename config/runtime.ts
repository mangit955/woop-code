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
  useTools = true,
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
      const toolCalls: Extract<StreamEvent, { type: "tool_call" }>[] = [];

      for await (const event of client.stream(
        recentMessages(messages, MAX_TURNS),
        repoContext,
        signal,
        useTools,
      )) {
        switch (event.type) {
          case "text":
            assistantText += event.content;
            callbacks.onText?.(event.content);
            break;

          case "tool_call":
            toolCalls.push(event);
            break;

          case "done":
            break;
        }
      }

      if (signal?.aborted) {
        callbacks.onCancel?.();
        return "";
      }

      if (toolCalls.length === 0) {
        messages.push({
          role: "assistant",
          content: assistantText,
        });

        callbacks.onDone?.();

        return assistantText;
      }

      // A provider can request several independent tools in one response. Run
      // every requested call before asking the model for its next turn.
      for (const toolCall of toolCalls) {
        const tool = getTool(toolCall.name);

        if (!tool) {
          throw new Error(`Unknown tool: ${toolCall.name}`);
        }

        let toolKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;

        if (toolCall.name === "run_terminal" && toolCall.arguments.command) {
          const cmd = String(toolCall.arguments.command).trim();
          const normalizedCmd = cmd
            .replace(/^cd\s+\S+\s+&&\s+/, "")
            .replace(/bun (add|install)/, "install")
            .replace(/npm (i|install)/, "install")
            .replace(/\s+/g, " ")
            .trim();
          toolKey = `run_terminal:${normalizedCmd}`;
        }

        const callCount = executedTools.get(toolKey) || 0;

        if (callCount >= SAME_TOOL_THRESHOLD) {
          const output =
            `Skipped duplicate ${toolCall.name} call. The result for these exact arguments ` +
            `is already in the conversation; use it and continue with a different action.`;

          callbacks.onToolStart?.({ id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments });
          messages.push({
            role: "assistant_tool_call", toolName: toolCall.name, toolCallId: toolCall.id,
            arguments: toolCall.arguments, thoughtSignature: toolCall.thoughtSignature,
          });
          callbacks.onToolFinish?.({ id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments, output });
          messages.push({ role: "tool", toolName: toolCall.name, toolCallId: toolCall.id, content: output });
          continue;
        }

        executedTools.set(toolKey, callCount + 1);
        callbacks.onToolStart?.({
          id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments,
        });

        messages.push({
          role: "assistant_tool_call", toolName: toolCall.name, toolCallId: toolCall.id,
          arguments: toolCall.arguments, thoughtSignature: toolCall.thoughtSignature,
        });

        let result: string;
        try {
          result = await tool.execute(toolCall.arguments, signal);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          callbacks.onToolError?.({ id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments, error: message });
          messages.push({ role: "tool", toolName: toolCall.name, toolCallId: toolCall.id, content: `Tool failed: ${message}` });
          continue;
        }

        // A tool may have completed at the same time that the user cancelled
        // the turn. Do not report its result or start another provider call.
        if (signal?.aborted) {
          callbacks.onCancel?.();
          return "";
        }
        const MAX_TOOL_RESULT = 4000;
        const toolResult =
          result.length > MAX_TOOL_RESULT
            ? result.slice(0, MAX_TOOL_RESULT) + "\n\n...output truncated..."
            : result;

        const editWasDeclined =
          toolResult.startsWith("Edit rejected") || toolResult.startsWith("Edit cancelled");

        if (editWasDeclined) {
          callbacks.onToolError?.({ id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments, error: "Rejected by user" });
          messages.push({ role: "tool", toolName: toolCall.name, toolCallId: toolCall.id, content: toolResult });

          const outcome = "The proposed file change was not applied because it was rejected.";
          messages.push({ role: "assistant", content: outcome });
          callbacks.onText?.(outcome);
          callbacks.onDone?.();
          return outcome;
        }

        callbacks.onToolFinish?.({
          id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments, output: toolResult,
        });

        messages.push({
          role: "tool", toolName: toolCall.name, toolCallId: toolCall.id, content: toolResult,
        } as Message);
      }
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
