import { getTool } from "../tools";
import { classifyCommand, commandOf, toolEffect } from "../runtime/toolEffects";
import { isRetryableError } from "../runtime/retry";
import { compactToolHistory, toolHistoryBudget } from "../runtime/compaction";
import { recentMessages } from "./config";
import { SYSTEM_PROMPT } from "./systemPrompt";
import type {
  AgentCallbacks,
  Message,
  PromptSegments,
  ProviderClient,
  TurnContext,
  StreamEvent,
  TokenUsage,
  TurnSummary,
} from "./types";

/** Characters of a single tool result that reach the model. */
export const MAX_TOOL_RESULT = 4000;

/**
 * Trims an oversized tool result, keeping both ends.
 *
 * Truncation used to keep the first 4000 characters and drop the rest, which
 * discarded exactly the part that usually matters: a test run puts its summary
 * last, a build puts its errors last, and a stack trace puts the root cause
 * last. An agent shown only the head of a failing test run sees that it ran and
 * not that it failed.
 *
 * The head is kept too, because read_file has no range parameter — an agent
 * that loses the top of a file cannot ask for it again, it can only re-read the
 * whole thing. Both ends are cut to line boundaries so neither resumes
 * mid-token, and the marker states what was dropped rather than implying the
 * output simply ended.
 */
export function truncateToolResult(
  result: string,
  limit = MAX_TOOL_RESULT,
): string {
  if (result.length <= limit) return result;

  const half = Math.floor(limit / 2);

  // Extend to the enclosing line break where one is close enough to be the
  // real boundary; falling back to the raw offset keeps a single enormous line
  // (minified output, a long JSON blob) from collapsing the whole budget.
  const headCut = result.lastIndexOf("\n", half);
  const head = result.slice(0, headCut > half * 0.5 ? headCut : half);

  const tailStart = result.length - half;
  const tailCut = result.indexOf("\n", tailStart);
  const tail = result.slice(
    tailCut !== -1 && tailCut < result.length - half * 0.5 ? tailCut + 1 : tailStart,
  );

  const dropped = result.length - head.length - tail.length;
  const lines = result.slice(head.length, result.length - tail.length).split("\n").length - 1;

  return (
    `${head}\n\n…${dropped} characters omitted from the middle` +
    `${lines > 0 ? ` (${lines} lines)` : ""}; ` +
    `the start and end of the output are shown…\n\n${tail}`
  );
}

/**
 * Measures the pieces of the prompt about to be sent.
 *
 * Deliberately measures the messages that are actually sent — the result of
 * `recentMessages`, not the full transcript — so the numbers describe the
 * request rather than what the session happens to be holding in memory.
 */
export function measureSegments(
  messages: Message[],
  context: TurnContext,
): PromptSegments {
  const { repository, executionLog } = normalizeContext(context);
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
    repoContext: repository.length,
    executionLog: executionLog.length,
    conversation,
    toolResults,
  };
}

/** Accepts the older string form and the split form as one shape. */
function normalizeContext(context: TurnContext): {
  repository: string;
  executionLog: string;
} {
  return typeof context === "string"
    ? { repository: context, executionLog: "" }
    : { repository: context.repository, executionLog: context.executionLog ?? "" };
}

/**
 * Renders the turn context into the single string the provider receives.
 *
 * The join lives here rather than in the caller so that one place decides how
 * the pieces are ordered and separated, and the measurement above cannot drift
 * from what is actually sent.
 */
export function renderContext(context: TurnContext): string {
  const { repository, executionLog } = normalizeContext(context);
  if (!executionLog) return repository;
  return repository ? `${repository}\n\n${executionLog}` : executionLog;
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
  context: TurnContext,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
  useTools = true,
) {
  const MAX_ITERATIONS = maxIterations();
  // Rendered once: the provider receives one string, while the measurement
  // above keeps the pieces apart.
  const renderedContext = renderContext(context);
  // Read once per turn so a mid-turn environment change cannot make two
  // iterations of the same turn assemble to different rules.
  const historyBudget = toolHistoryBudget();
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

  // Verification tracking. Counted in tool executions rather than iterations
  // because a single iteration can edit a file and then run the tests, and the
  // order within it is the whole question.
  const toolCounts: Record<string, number> = {};
  let toolStep = 0;
  let lastWriteStep: number | undefined;
  let lastShellStep: number | undefined;
  // Counted for the turn, not the iteration: a benchmark reading the summary
  // needs to tell a slow run from a flaky one.
  let retries = 0;
  // Iterations whose stream died after the model had already said something,
  // and whose partial output was kept rather than discarded.
  let salvagedIterations = 0;

  /**
   * Turns asked to check their own edits before finishing.
   *
   * A benchmark run ended four of five trials having changed files with nothing
   * run afterwards to check them — one of them made four edits and ran zero
   * verifications across two hundred iterations. The model is told to verify in
   * the system prompt; nothing ever checked that it had.
   */
  let verificationReminders = 0;
  /**
   * Asked once, never twice. The model may have a good reason not to verify —
   * the change may be unverifiable, or the tests may not exist — and a loop
   * that insists would spend the budget arguing rather than let the turn end.
   */
  const MAX_VERIFICATION_REMINDERS = 1;

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
      // Compaction is opt-in; see runtime/compaction.ts for the benchmark that
      // turned it off. When enabled it applies to the request only, because the
      // execution log is built from `messages` after the turn and shrinking
      // what is sent is not the same as forgetting what happened.
      const windowed = recentMessages(messages, MAX_TURNS);
      const sentMessages =
        historyBudget === null
          ? windowed
          : compactToolHistory(windowed, historyBudget);
      const segments = measureSegments(sentMessages, context);
      const iterationStartedAt = Date.now();
      let usage: TokenUsage | undefined;

      // Set when the stream dies after the model has already said something.
      // The client retries only while nothing has been observed, because
      // repeating the request would duplicate text the user watched arrive —
      // so recovering a half-delivered response is this loop's job.
      let truncated: Error | undefined;

      try {
        for await (const event of client.stream(
          sentMessages,
          renderedContext,
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

            case "retry":
              retries++;
              callbacks.onRetry?.({
                attempt: event.attempt,
                delayMs: event.delayMs,
                reason: event.reason,
                error: event.error,
              });
              // The ⚠️ prefix keeps this in the transcript as a notice rather
              // than replacing the activity indicator: the turn is still running.
              callbacks.onStatus?.(
                `⚠️  provider request failed (${event.reason}), retrying in ${Math.round(event.delayMs / 100) / 10}s`,
              );
              break;

            case "done":
              usage = event.usage;
              break;
          }
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));

        // Cancellation is handled by the check below, not salvaged.
        if (signal?.aborted) {
          callbacks.onCancel?.();
          return "";
        }

        // Nothing was observed, so the client already exhausted its retries and
        // there is nothing to keep. Let the failure travel.
        if (!assistantText && toolCalls.length === 0) {
          throw failure;
        }

        // Only a transient failure is worth continuing from. A fatal one — a
        // rejected request, a bug — would otherwise be retried until the
        // iteration budget ran out, burning quota to arrive at the same error
        // twenty iterations later instead of reporting it now.
        if (!isRetryableError(failure)) {
          throw failure;
        }

        truncated = failure;
      }

      if (signal?.aborted) {
        callbacks.onCancel?.();
        return "";
      }

      if (truncated) {
        salvagedIterations++;
        callbacks.onStatus?.(
          `⚠️  response was cut short (${truncated.message}); continuing from what arrived`,
        );
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

        // A stream that died mid-sentence is not the model choosing to stop.
        // Returning here would end the turn on a half-written answer, so the
        // partial text stays and the loop asks again.
        //
        // The follow-up has to be a user message. Gemini rejects a request
        // whose last message is from the model — "Requests ending with a model
        // turn are not supported" — so continuing after an assistant message
        // without one fails with a 400. That costs one of the turns
        // recentMessages keeps, which is the price of continuing at all.
        if (truncated) {
          messages.push({
            role: "user",
            content:
              "Your previous message was cut off before it finished. Continue from where it stopped.",
          });
          continue;
        }

        // The turn is about to end having changed files with nothing run
        // afterwards to check them. Ask once, then let it finish either way.
        const unverified =
          lastWriteStep !== undefined &&
          (lastShellStep === undefined || lastShellStep < lastWriteStep);

        if (
          unverified &&
          verificationReminders < MAX_VERIFICATION_REMINDERS &&
          iterations < MAX_ITERATIONS
        ) {
          verificationReminders++;
          messages.push({
            role: "user",
            content:
              "You changed files and have not run anything since. Run the project's " +
              "tests, build or type check to confirm the change works, then report the " +
              "result. If it genuinely cannot be verified — no test exists, or the " +
              "tooling is unavailable — say so plainly and finish. Do not claim it was " +
              "verified unless a command actually ran.",
          });
          callbacks.onStatus?.(
            "⚠️  files changed without a check - asking the agent to verify",
          );
          continue;
        }

        callbacks.onDone?.();

        return assistantText;
      }

      // A provider can request several independent tools in one response. Run
      // every requested call before asking the model for its next turn.
      //
      // They are tagged with the response they arrived in: a model that batches
      // calls signs only the first of them, and the provider rejects history
      // that splits such a batch across separate turns.
      const batchId = crypto.randomUUID();

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
            batchId,
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
          batchId,
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
        const toolResult = truncateToolResult(result);

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

        // Recorded here rather than before execute: a tool that threw changed
        // nothing, and a declined edit returned above without reaching this
        // point, so neither is counted as a workspace change.
        toolStep++;
        toolCounts[toolCall.name] = (toolCounts[toolCall.name] ?? 0) + 1;
        switch (toolEffect(toolCall.name)) {
          case "write":
            lastWriteStep = toolStep;
            break;

          case "shell": {
            // Judged from the command, not the tool name. A benchmark run
            // showed the agent doing its real editing through run_terminal —
            // `sed -i`, `cat >> file` — which name-only classification recorded
            // as verification, the opposite of what it is.
            const { writes, verifies } = classifyCommand(
              commandOf(toolCall.arguments),
            );

            // Order matters when a command does both: `sed -i f.c && make`
            // edited and then checked, and the check has to land afterwards for
            // the edit to count as verified.
            if (writes) lastWriteStep = toolStep;
            if (verifies) lastShellStep = writes ? ++toolStep : toolStep;
            break;
          }
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
  } finally {
    // Every exit is a turn that ended and is worth a record: a normal
    // completion, a rejected edit, cancellation, an exhausted budget, a
    // provider failure. A finally is what makes that exactly one record per
    // call regardless of which path got here.
    callbacks.onTurnSummary?.({
      iterations,
      retries,
      salvagedIterations,
      verificationReminders,
      toolCalls: toolCallsExecuted,
      lastWriteStep,
      lastShellStep,
      toolCounts,
      unverifiedEdits:
        lastWriteStep !== undefined &&
        (lastShellStep === undefined || lastShellStep < lastWriteStep),
    });
  }
}
