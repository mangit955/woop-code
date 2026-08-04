import { getTool, toolRegistry } from "../tools";
import { classifyCommand, commandOf, toolEffect } from "./toolEffects";
import { blockedInPlanMode, planModeRefusal, planModeTools } from "./planMode";
import { isRetryableError } from "./retry";
import { compactToolHistory, toolHistoryBudget } from "./compaction";
import { TurnState, normalizeToolKey } from "./turnState";
import { recentMessages } from "../config/config";
import { SYSTEM_PROMPT } from "../config/systemPrompt";
import type {
  AgentCallbacks,
  Message,
  PromptSegments,
  ProviderClient,
  TurnContext,
  StreamEvent,
  TokenUsage,
  Tool,
} from "../config/types";

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
  const { repository, executionLog, instructions } = normalizeContext(context);
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
    // Omitted rather than reported as 0 when there are none, so an ordinary turn
    // measures exactly as it did before modes existed.
    ...(instructions ? { modeInstructions: instructions.length } : {}),
  };
}

/** Accepts the older string form and the split form as one shape. */
function normalizeContext(context: TurnContext): {
  repository: string;
  executionLog: string;
  instructions: string;
} {
  return typeof context === "string"
    ? { repository: context, executionLog: "", instructions: "" }
    : {
        repository: context.repository,
        executionLog: context.executionLog ?? "",
        instructions: context.instructions ?? "",
      };
}

/**
 * Renders the turn context into the single string the provider receives.
 *
 * The join lives here rather than in the caller so that one place decides how
 * the pieces are ordered and separated, and the measurement above cannot drift
 * from what is actually sent.
 */
export function renderContext(context: TurnContext): string {
  const { repository, executionLog, instructions } = normalizeContext(context);

  // Instructions come first: they say how this turn must behave, which the model
  // should read before the material it is to act on. Ordered explicitly here so
  // the measurement above and the string sent cannot drift apart.
  return [instructions, repository, executionLog].filter(Boolean).join("\n\n");
}

/** Loop budget when nothing overrides it — tuned for interactive use. */
const DEFAULT_MAX_ITERATIONS = 20;

/** Conversation turns kept in the window sent to the provider. */
const MAX_TURNS = 6;

/**
 * Repeats of one call, with identical arguments, before it is skipped.
 *
 * Four allowed three wasted round trips before acting. A benchmark trial ran
 * `readelf -s doomgeneric_mips | grep -i init` three times and several other
 * readelf variants twice each, all inside a budget it went on to exhaust. Two
 * is enough to let a genuine retry through — a command run again after
 * something changed — while ending a loop one step sooner.
 */
const SAME_TOOL_THRESHOLD = 2;

/** Iterations left when the model is told the budget is running out. */
const REMAINING_ITERATIONS_WARNING = 5;

/** Tools actually run before the turn is nudged toward implementing. */
const TOOLS_BEFORE_EFFICIENCY_WARNING = 6;

/**
 * Asked once, never twice. The model may have a good reason not to verify —
 * the change may be unverifiable, or the tests may not exist — and a loop that
 * insists would spend the budget arguing rather than let the turn end.
 */
const MAX_VERIFICATION_REMINDERS = 1;

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

/** Per-turn switches that are not part of the conversation. */
export interface AgentLoopOptions {
  /**
   * Investigate but change nothing; see runtime/planMode.ts.
   *
   * Read once here, at the start of the turn, for the same reason the tool-history
   * budget and the thinking budget are: a mode toggled mid-turn would leave two
   * requests of one turn assembled under different rules. A Tab pressed while the
   * agent is working therefore takes effect on the next turn.
   */
  planMode?: boolean;
}

type ToolCallEvent = Extract<StreamEvent, { type: "tool_call" }>;

/** What one provider response produced. */
interface IterationResult {
  assistantText: string;
  toolCalls: ToolCallEvent[];
  usage?: TokenUsage;
  /**
   * Set when the stream died after the model had already said something.
   *
   * The client retries only while nothing has been observed, because repeating
   * the request would duplicate text the user watched arrive — so recovering a
   * half-delivered response is this loop's job, not the client's.
   */
  truncated?: Error;
  /** The user cancelled. Reported rather than thrown, so the caller decides how to end. */
  cancelled?: boolean;
}

/**
 * Runs one provider request to completion, collecting text and tool calls.
 *
 * A stream that fails is salvaged only when there is something to salvage and
 * the failure was transient; otherwise the error travels and ends the turn.
 */
async function streamIteration(
  client: ProviderClient,
  sentMessages: Message[],
  renderedContext: string,
  offeredTools: readonly Tool[],
  useTools: boolean,
  callbacks: AgentCallbacks,
  state: TurnState,
  signal?: AbortSignal,
): Promise<IterationResult> {
  let assistantText = "";
  const toolCalls: ToolCallEvent[] = [];
  let usage: TokenUsage | undefined;

  try {
    for await (const event of client.stream(
      sentMessages,
      renderedContext,
      signal,
      useTools,
      offeredTools,
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
          state.retries++;
          callbacks.onRetry?.({
            attempt: event.attempt,
            delayMs: event.delayMs,
            reason: event.reason,
            error: event.error,
          });
          // The ⚠️ prefix keeps this in the transcript as a notice rather than
          // replacing the activity indicator: the turn is still running.
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

    // Cancellation is not salvaged; the caller handles it.
    if (signal?.aborted) {
      return { assistantText, toolCalls, usage, cancelled: true };
    }

    // Nothing was observed, so the client already exhausted its retries and
    // there is nothing to keep. Let the failure travel.
    if (!assistantText && toolCalls.length === 0) {
      throw failure;
    }

    // Only a transient failure is worth continuing from. A fatal one — a
    // rejected request, a bug — would otherwise be retried until the iteration
    // budget ran out, burning quota to arrive at the same error twenty
    // iterations later instead of reporting it now.
    if (!isRetryableError(failure)) {
      throw failure;
    }

    return { assistantText, toolCalls, usage, truncated: failure };
  }

  return { assistantText, toolCalls, usage };
}

/**
 * Announces a call and records it in the conversation.
 *
 * Every path through a tool call does these two things first — the ones that
 * run it, the ones that skip it as a duplicate, and the ones plan mode refuses
 * — because the provider requires the call to appear in history whether or not
 * anything executed. The `batchId` ties calls that arrived in one response
 * together: a model that batches signs only the first, and the provider rejects
 * history that splits such a batch across turns.
 */
function recordToolCall(
  messages: Message[],
  callbacks: AgentCallbacks,
  toolCall: ToolCallEvent,
  batchId: string,
): void {
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
}

/** Feeds a result back to the model. Every call owes exactly one of these. */
function pushToolResult(
  messages: Message[],
  toolCall: ToolCallEvent,
  content: string,
): void {
  messages.push({
    role: "tool",
    toolName: toolCall.name,
    toolCallId: toolCall.id,
    content,
  });
}

/** How a single tool call ended, from the loop's point of view. */
type ToolCallOutcome =
  | { kind: "continue" }
  | { kind: "cancelled" }
  | { kind: "declined"; outcome: string };

/**
 * Runs one requested tool call, or declines to.
 *
 * Four things can happen before the tool is reached: it is unknown (thrown, a
 * bug), it repeats a call already made (skipped), plan mode refuses it, or the
 * user cancels. Each still owes the model a result, because a call left without
 * one makes the history invalid for the next request.
 */
async function executeToolCall(
  toolCall: ToolCallEvent,
  messages: Message[],
  callbacks: AgentCallbacks,
  state: TurnState,
  batchId: string,
  planMode: boolean,
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  const tool = getTool(toolCall.name);

  if (!tool) {
    throw new Error(`Unknown tool: ${toolCall.name}`);
  }

  const toolKey = normalizeToolKey(toolCall.name, toolCall.arguments);

  if (state.seenCount(toolKey) >= SAME_TOOL_THRESHOLD) {
    const output =
      `Skipped duplicate ${toolCall.name} call. The result for these exact arguments ` +
      `is already in the conversation; use it and continue with a different action.`;

    recordToolCall(messages, callbacks, toolCall, batchId);
    callbacks.onToolFinish?.({
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      output,
    });
    pushToolResult(messages, toolCall, output);
    return { kind: "continue" };
  }

  // Plan mode's second gate. The tool never runs, and the model is told why as
  // a result rather than an exception, so it can adjust and finish the plan
  // instead of losing the turn.
  //
  // Counted against the duplicate threshold but not against the tools executed:
  // a third identical attempt should be skipped as a repeat, and nothing ran,
  // so nothing is owed to the efficiency warning.
  if (planMode && blockedInPlanMode(toolCall.name, toolCall.arguments)) {
    state.countAttempt(toolKey);
    recordToolCall(messages, callbacks, toolCall, batchId);
    // Its own callback, not onToolError: the tool did not fail, it was never
    // run. The write marks are deliberately untouched too — nothing was
    // written, so the turn must not look like an unverified edit.
    callbacks.onToolBlocked?.({
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      error: "Plan mode",
    });
    pushToolResult(messages, toolCall, planModeRefusal(toolCall.name));
    return { kind: "continue" };
  }

  state.countAttempt(toolKey);
  state.toolCallsExecuted++;
  recordToolCall(messages, callbacks, toolCall, batchId);

  let result: string;
  try {
    result = await tool.execute(toolCall.arguments, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    callbacks.onToolError?.({
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      error: message,
    });
    pushToolResult(messages, toolCall, `Tool failed: ${message}`);
    return { kind: "continue" };
  }

  // A tool may have completed at the same time that the user cancelled the
  // turn. Do not report its result or start another provider call.
  if (signal?.aborted) {
    return { kind: "cancelled" };
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
    pushToolResult(messages, toolCall, toolResult);

    const outcome =
      "The proposed file change was not applied because it was rejected.";
    messages.push({ role: "assistant", content: outcome });
    callbacks.onText?.(outcome);
    return { kind: "declined", outcome };
  }

  // Recorded here rather than before execute: a tool that threw changed
  // nothing, and a declined edit returned above without reaching this point, so
  // neither is counted as a workspace change.
  state.recordToolEffect(toolCall.name, toolCall.arguments);

  callbacks.onToolFinish?.({
    id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.arguments,
    output: toolResult,
  });

  pushToolResult(messages, toolCall, toolResult);
  return { kind: "continue" };
}

/** Whether the turn is over, or the loop should ask the model once more. */
type TurnEnding = { kind: "continue" } | { kind: "done"; text: string };

/**
 * Decides what happens when the model responds without calling any tool.
 *
 * Usually that means it is finished. Twice it does not: a stream that died
 * mid-sentence has to be resumed, and a turn that changed files without
 * checking them is asked once to verify. Both push a user message and go round
 * again, which is why this returns an instruction rather than a value.
 */
function finishTurn(
  messages: Message[],
  callbacks: AgentCallbacks,
  state: TurnState,
  assistantText: string,
  maxIterations: number,
  truncated?: Error,
): TurnEnding {
  messages.push({ role: "assistant", content: assistantText });

  // A stream that died mid-sentence is not the model choosing to stop. Ending
  // here would finish the turn on a half-written answer, so the partial text
  // stays and the loop asks again.
  //
  // The follow-up has to be a user message. Gemini rejects a request whose last
  // message is from the model — "Requests ending with a model turn are not
  // supported" — so continuing after an assistant message without one fails
  // with a 400. That costs one of the turns recentMessages keeps, which is the
  // price of continuing at all.
  if (truncated) {
    messages.push({
      role: "user",
      content:
        "Your previous message was cut off before it finished. Continue from where it stopped.",
    });
    return { kind: "continue" };
  }

  // The turn is about to end having changed files with nothing run afterwards
  // to check them. Ask once, then let it finish either way.
  if (
    state.hasUnverifiedEdits() &&
    state.verificationReminders < MAX_VERIFICATION_REMINDERS &&
    state.iterations < maxIterations
  ) {
    state.verificationReminders++;
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
    return { kind: "continue" };
  }

  return { kind: "done", text: assistantText };
}

export async function agentLoop(
  client: ProviderClient,
  messages: Message[],
  context: TurnContext,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
  useTools = true,
  options: AgentLoopOptions = {},
) {
  const MAX_ITERATIONS = maxIterations();
  const planMode = options.planMode === true;
  // Withholding the writing tools is the first of plan mode's two gates. The
  // second is the refusal below, which is what covers a write reaching the disk
  // through run_terminal — a tool this list has to keep.
  const offeredTools = planMode ? planModeTools(toolRegistry) : toolRegistry;
  // Rendered once: the provider receives one string, while the measurement
  // above keeps the pieces apart.
  const renderedContext = renderContext(context);
  // Read once per turn so a mid-turn environment change cannot make two
  // iterations of the same turn assemble to different rules.
  const historyBudget = toolHistoryBudget();

  const state = new TurnState();

  try {
    while (state.iterations < MAX_ITERATIONS) {
      state.iterations++;

      // This one is about the loop budget, so the iteration counter is the
      // right measure.
      //
      // Said to the model as well as to the terminal. A benchmark trial that
      // exhausted its 200 iterations was still writing at its 198th tool call,
      // because this warning only ever reached stderr. A status callback cannot
      // change what the model does next; a message in the conversation can.
      if (state.iterations === MAX_ITERATIONS - REMAINING_ITERATIONS_WARNING) {
        const remaining = MAX_ITERATIONS - state.iterations;
        callbacks.onStatus?.(
          `⚠️  ${remaining} iterations remaining - prioritize completion`,
        );
        messages.push({
          role: "user",
          content:
            `Only ${remaining} more steps are available before this turn is stopped. ` +
            `Finish what you have started rather than beginning anything new, ` +
            `make sure the work is in a usable state, and report what is done and ` +
            `what is not.`,
        });
      }

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

      const iteration = await streamIteration(
        client,
        sentMessages,
        renderedContext,
        offeredTools,
        useTools,
        callbacks,
        state,
        signal,
      );

      if (iteration.cancelled) {
        callbacks.onCancel?.();
        return "";
      }

      const { assistantText, toolCalls, usage, truncated } = iteration;

      if (signal?.aborted) {
        callbacks.onCancel?.();
        return "";
      }

      if (truncated) {
        state.salvagedIterations++;
        callbacks.onStatus?.(
          `⚠️  response was cut short (${truncated.message}); continuing from what arrived`,
        );
      }

      // After the cancellation check: a turn the user interrupted did not
      // complete an iteration, and reporting one would put a half-measured
      // request into the log.
      callbacks.onUsage?.({
        iteration: state.iterations,
        usage,
        segments,
        toolCalls: toolCalls.length,
        durationMs: Date.now() - iterationStartedAt,
      });

      if (toolCalls.length === 0) {
        const ending = finishTurn(
          messages,
          callbacks,
          state,
          assistantText,
          MAX_ITERATIONS,
          truncated,
        );

        if (ending.kind === "continue") continue;

        callbacks.onDone?.();
        return ending.text;
      }

      // A provider can request several independent tools in one response. Run
      // every requested call before asking the model for its next turn.
      //
      // They are tagged with the response they arrived in: a model that batches
      // calls signs only the first of them, and the provider rejects history
      // that splits such a batch across separate turns.
      const batchId = crypto.randomUUID();

      for (const toolCall of toolCalls) {
        const outcome = await executeToolCall(
          toolCall,
          messages,
          callbacks,
          state,
          batchId,
          planMode,
          signal,
        );

        if (outcome.kind === "cancelled") {
          callbacks.onCancel?.();
          return "";
        }

        if (outcome.kind === "declined") {
          callbacks.onDone?.();
          return outcome.outcome;
        }
      }

      // Reported once, after the tools of this iteration have run, so the
      // count is what was actually used rather than how many times the model
      // has been asked to respond.
      if (
        !state.efficiencyWarningSent &&
        state.toolCallsExecuted >= TOOLS_BEFORE_EFFICIENCY_WARNING
      ) {
        state.efficiencyWarningSent = true;
        // The ⚠️ prefix is load-bearing: it is how the UI tells an informational
        // notice from a terminal status, so it shows in the transcript and the
        // activity indicator keeps saying the turn is still running.
        callbacks.onStatus?.(
          `⚠️  ${state.toolCallsExecuted} tools used - start implementing now to conserve quota`,
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
    callbacks.onTurnSummary?.(state.toSummary());
  }
}
