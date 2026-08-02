import { getTool } from "../tools";
import { recentMessages } from "./config";
import { SYSTEM_PROMPT } from "./systemPrompt";
import type {
  AgentCallbacks,
  Message,
  PromptSegments,
  ProviderClient,
  StreamEvent,
  TokenUsage,
} from "./types";

/**
 * Measures the pieces of the prompt about to be sent.
 *
 * Deliberately measures the messages that are actually sent — the result of
 * `recentMessages`, not the full transcript — so the numbers describe the
 * request rather than what the session happens to be holding in memory.
 */
export function measureSegments(
  messages: Message[],
  repoContext: string,
): PromptSegments {
  let conversation = 0;
  let toolResults = 0;

  for (const message of messages) {
    switch (message.role) {
      case "user":
      case "assistant":
        conversation += message.content.length;
        break;

      case "assistant_tool_call":
        // The arguments are what is serialised into the request, so they are
        // what counts here; the tool's name is negligible beside them.
        toolResults += JSON.stringify(message.arguments).length;
        break;

      case "tool":
        toolResults += message.content.length;
        break;
    }
  }

  return {
    systemPrompt: SYSTEM_PROMPT.length,
    repoContext: repoContext.length,
    conversation,
    toolResults,
  };
}

/** Loop budget when nothing overrides it — tuned for interactive use. */
const DEFAULT_MAX_ITERATIONS = 20;

/**
 * Raised when the loop runs out of iterations.
 *
 * Distinct from a generic failure because it is not one: the agent ran, it
 * simply did not finish inside its budget. Callers that report an exit status
 * use this to separate "produced an incomplete result" from "something broke",
 * which matters to any harness that treats the two differently.
 */
export class IterationBudgetExhaustedError extends Error {
  constructor(limit: number) {
    super(
      `Agent exceeded the maximum number of iterations (${limit}).\n\n` +
        `This usually means:\n` +
        `  • The task is too complex - try breaking it into smaller steps\n` +
        `  • The agent is stuck in analysis - it may need clearer instructions\n` +
        `  • More iterations are needed - raise WOOPCODE_MAX_ITERATIONS`,
    );
    this.name = "IterationBudgetExhaustedError";
  }
}

/**
 * Resolves the loop budget, allowing `WOOPCODE_MAX_ITERATIONS` to raise it.
 *
 * The interactive default is deliberately small: a human is watching, and a
 * runaway loop spends their quota. Automated callers working a single hard
 * task have the opposite tradeoff and need a far larger budget, so the limit
 * has to be settable from outside rather than compiled in.
 */
function maxIterations(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WOOPCODE_MAX_ITERATIONS?.trim();
  if (!raw) return DEFAULT_MAX_ITERATIONS;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    process.stderr.write(
      `⚠️  ignoring WOOPCODE_MAX_ITERATIONS=${raw} (expected a positive integer)\n`,
    );
    return DEFAULT_MAX_ITERATIONS;
  }
  return parsed;
}

export async function agentLoop(
  client: ProviderClient,
  messages: Message[],
  repoContext: string,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
  useTools = true,
) {
  const MAX_ITERATIONS = maxIterations();
  const MAX_TURNS = 6; // Reduced from 8 to limit context/token usage
  const SAME_TOOL_THRESHOLD = 4;
  /** Tools actually run before the turn is nudged toward implementing. */
  const TOOLS_BEFORE_EFFICIENCY_WARNING = 6;

  const executedTools = new Map<string, number>();

  let iterations = 0;
  // One iteration is one provider response, which can carry several tool calls
  // or none at all, so tool usage has to be counted where tools are actually
  // run rather than inferred from the loop counter.
  let toolCallsExecuted = 0;
  let efficiencyWarningSent = false;

  try {
    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // This one is about the loop budget, so the iteration counter is the
      // right measure.
      if (iterations === MAX_ITERATIONS - 5) {
        callbacks.onStatus?.(
          `⚠️  ${MAX_ITERATIONS - iterations} iterations remaining - prioritize completion`,
        );
      }

      let assistantText = "";
      const toolCalls: Extract<StreamEvent, { type: "tool_call" }>[] = [];

      // Measured from the same array that is sent, so the segment sizes and
      // the provider's token count describe one and the same request.
      const sentMessages = recentMessages(messages, MAX_TURNS);
      const segments = measureSegments(sentMessages, repoContext);
      const iterationStartedAt = Date.now();
      let usage: TokenUsage | undefined;

      for await (const event of client.stream(
        sentMessages,
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
            usage = event.usage;
            break;
        }
      }

      if (signal?.aborted) {
        callbacks.onCancel?.();
        return "";
      }

      // After the cancellation check: a turn the user interrupted did not
      // complete an iteration, and reporting one would put a half-measured
      // request into the log.
      callbacks.onUsage?.({
        iteration: iterations,
        usage,
        segments,
        toolCalls: toolCalls.length,
        durationMs: Date.now() - iterationStartedAt,
      });

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
        toolCallsExecuted++;
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
          result = await tool.execute(toolCall.arguments, signal);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
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
          toolResult.startsWith("Edit rejected") ||
          toolResult.startsWith("Edit cancelled");

        if (editWasDeclined) {
          callbacks.onToolError?.({
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
            error: "Rejected by user",
          });
          messages.push({
            role: "tool",
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            content: toolResult,
          });

          const outcome =
            "The proposed file change was not applied because it was rejected.";
          messages.push({ role: "assistant", content: outcome });
          callbacks.onText?.(outcome);
          callbacks.onDone?.();
          return outcome;
        }

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

      // Reported once, after the tools of this iteration have run, so the
      // count is what was actually used rather than how many times the model
      // has been asked to respond.
      if (
        !efficiencyWarningSent &&
        toolCallsExecuted >= TOOLS_BEFORE_EFFICIENCY_WARNING
      ) {
        efficiencyWarningSent = true;
        // The ⚠️ prefix is load-bearing: it is how the UI tells an informational
        // notice from a terminal status, so it shows in the transcript and the
        // activity indicator keeps saying the turn is still running.
        callbacks.onStatus?.(
          `⚠️  ${toolCallsExecuted} tools used - start implementing now to conserve quota`,
        );
      }
    }

    throw new IterationBudgetExhaustedError(MAX_ITERATIONS);
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
