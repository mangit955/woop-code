import { getTool, toolRegistry } from "../tools";
import { closeReplSessions } from "../tools/replSession";
import { takePendingImages } from "../tools/readImage";
import { blockedInPlanMode, planModeRefusal, planModeTools } from "./planMode";
import { isRetryableError } from "./retry";
import { compactToolHistory, toolHistoryBudget } from "./compaction";
import {
  WALL_RESERVE_SEC,
  clearDeadline,
  deadlineReached,
  setDeadline,
} from "./deadline";
import { TurnState, normalizeToolKey } from "./turnState";
import { recentMessages, turnInitiatingIndex } from "../config/config";
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

/**
 * Steps a turn may take before it stops to ask whether to keep going.
 *
 * Not a quota guard, though it was written as one. The provider enforces quota
 * itself and exactly: a 429 carries a `RetryInfo` saying when to come back,
 * `providerRetryDelayMs` honours it, and the client turns it into a message
 * naming the quota page. A constant here cannot know what is left of anyone's
 * budget, so as a spending limit it is always either too tight or too loose.
 *
 * What it does guard is a pathological loop with nobody watching — an agent
 * re-reading the same three files until the day's requests are gone. That wants
 * a ceiling high enough that ordinary work never reaches it. Twenty was not:
 * turns were dying mid-edit, having done nothing wrong, and the number fired
 * almost only on the false positive. Reaching this one asks rather than fails
 * (see `onBudgetExhausted`), which is what makes it safe to be generous.
 */
const DEFAULT_MAX_ITERATIONS = 40;

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

/**
 * Asked once, never twice. The model may have a good reason not to verify —
 * the change may be unverifiable, or the tests may not exist — and a loop that
 * insists would spend the budget arguing rather than let the turn end.
 */
const MAX_VERIFICATION_REMINDERS = 1;

/**
 * Steps the verification reminder needs before it is worth asking.
 *
 * Two, really — run the check, report what it printed — plus one for the answer
 * the model was about to give. What the floor actually guards against is a
 * reminder injected against a clock with nothing left: the turn continues, the
 * deadline check at the top of the next iteration fires, and a turn that had a
 * finished answer in hand ends as `WallBudgetExhaustedError` and exit status 2
 * instead. The old guard was `iterations < budget`, which cannot see a clock at
 * all, so the case was reachable on every wall-budgeted run.
 */
const VERIFICATION_GATE_MIN_STEPS = 3;

/** Asked once, for the same reason the verification reminder is. */
const MAX_REQUIREMENT_REMINDERS = 1;

/**
 * Steps the requirement gate needs before it is worth asking.
 *
 * Twice `REMAINING_ITERATIONS_WARNING`, deliberately. This gate asks the model
 * to enumerate a task's requirements and run a command for each one it cannot
 * prove, which is work — and at the warning threshold the loop is telling it
 * the opposite, to finish what it started and begin nothing new. Two
 * instructions in one request, contradicting each other. The distance keeps
 * them apart, and `windDownWarned` covers the case the distance cannot: a rate
 * that dipped, warned, and recovered leaves the model told to wrap up while the
 * count reads healthy again.
 */
const REQUIREMENT_GATE_MIN_STEPS = 10;

/**
 * What the turn is told when it has changed files and checked nothing.
 *
 * Kept as constants because the two gates can fire on the same response, in
 * which case the model gets one message rather than a round trip each — window
 * slots are the scarce thing here, since every message the loop pushes counts
 * as one of the six turns `recentMessages` keeps.
 */
const VERIFICATION_REMINDER =
  "You changed files and have not run anything since. Run the project's " +
  "tests, build or type check to confirm the change works, then report the " +
  "result. If it genuinely cannot be verified — no test exists, or the " +
  "tooling is unavailable — say so plainly and finish. Do not claim it was " +
  "verified unless a command actually ran.";

/**
 * What the turn is told when it is about to finish with budget to spare.
 *
 * Aimed at a specific, observed failure rather than at carelessness in general:
 * a trial verified its work three times over and still scored zero, because the
 * task constrained *which* wording was allowed and every check it ran tested
 * only that something was present. So the message names that class outright —
 * constraints on what is not allowed, and on the form of the answer — and
 * refuses recollection as evidence, since the turn being interrupted is one
 * whose recollection is already wrong.
 *
 * "Above" is load-bearing and true: the task statement is pinned into the
 * window for the life of the turn.
 */
const REQUIREMENT_REMINDER =
  "Before finishing: go back to the task statement above and list every " +
  "requirement it states, including constraints on what is not allowed or what " +
  "form the answer must take. For each one, quote the exact command and output " +
  "that proves it holds. Do not answer from memory or from what you believe you " +
  "did — if you cannot point at output from a command in this session, run the " +
  "command now. If a requirement genuinely cannot be checked by a command, say " +
  "which and why, then finish.";

/**
 * Can the turn afford another round trip, and the work it is about to ask for?
 *
 * `stepsRemaining` answers for both budgets at once — it is the iteration
 * ceiling floored by the clock, converted at the rate this turn has been
 * running at — and the deadline is consulted directly as well, because that
 * conversion is deliberately not trusted until `MIN_RATE_SAMPLES` steps have
 * gone into it. Without the direct check, a turn that edited and finished
 * within two iterations of a nearly-spent budget would still be sent round.
 */
function canAffordAnotherRound(
  state: TurnState,
  iterationCeiling: number,
  minSteps: number,
  wallBudgeted: boolean,
): boolean {
  // Guarded on `wallBudgeted` for the same reason the loop's own check is
  // (`wallBudget !== null && deadlineReached()`): the deadline is module state,
  // so an unbudgeted turn that inherited an armed one would have both gates
  // silently withheld while the loop itself ran on, never throwing. The
  // `finally` that disarms makes that unreachable today; the guard costs a
  // parameter and stops the two readers of one clock disagreeing about it.
  if (wallBudgeted && deadlineReached()) return false;
  return state.stepsRemaining(iterationCeiling) >= minSteps;
}

/**
 * Raised when the loop runs out of budget, of either kind.
 *
 * Distinct from a generic failure because it is not one: the agent ran, it
 * simply did not finish inside its budget. Callers that report an exit status
 * use this to separate "produced an incomplete result" from "something broke",
 * which matters to any harness that treats the two differently — and both
 * budgets produce the same situation, so both answer to this one type. The
 * subclasses exist so the message can name the knob that actually bound.
 */
export class BudgetExhaustedError extends Error {}

/** Raised when the loop runs out of iterations. */
export class IterationBudgetExhaustedError extends BudgetExhaustedError {
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
 * Raised when the loop runs out of wall-clock time.
 *
 * Its own message rather than the iteration one, which tells the caller to
 * raise `WOOPCODE_MAX_ITERATIONS` — advice that would send whoever reads it to
 * the knob that did not bind, and the loop would stop at the same second again.
 */
export class WallBudgetExhaustedError extends BudgetExhaustedError {
  constructor(limitSeconds: number) {
    super(
      `Agent ran out of wall-clock time (${limitSeconds}s, less a ${WALL_RESERVE_SEC}s reserve ` +
        `for finishing up).\n\n` +
        `This usually means:\n` +
        `  • The task needs more time than the harness allows for it\n` +
        `  • Work is partially done - judge what is on disk rather than treating this as a crash\n` +
        `  • More time is needed - raise WOOPCODE_MAX_WALL_SEC`,
    );
    this.name = "WallBudgetExhaustedError";
  }
}

/**
 * Resolves the loop budget, allowing `WOOPCODE_MAX_ITERATIONS` to set it.
 *
 * An interactive session can afford a checkpoint at the ceiling, because
 * somebody is there to answer it. An automated caller cannot — there is nobody
 * to ask, so the number it starts with is the number it gets — which is why the
 * limit has to be settable from outside rather than compiled in.
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

/**
 * Resolves the wall-clock budget from `WOOPCODE_MAX_WALL_SEC`, in seconds.
 *
 * Null when unset, and that is the ordinary case: an interactive session has a
 * person deciding when a turn has gone on too long, and giving it a clock it
 * never asked for would end turns that were going fine. Only a harness that
 * enforces one of its own sets this, and it passes its whole budget — the
 * reserve is subtracted in `setDeadline`.
 *
 * Mirrors `maxIterations` down to the warn-and-fall-back, so a typo in a job
 * config is visible on stderr rather than being read as "no budget".
 */
function maxWallSeconds(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env.WOOPCODE_MAX_WALL_SEC?.trim();
  if (!raw) return null;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    process.stderr.write(
      `⚠️  ignoring WOOPCODE_MAX_WALL_SEC=${raw} (expected a positive integer)\n`,
    );
    return null;
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
  /**
   * Nobody is reading the answer as it arrives.
   *
   * Set by the headless path, which is the one where a wrong answer stands: an
   * interactive user reads the claim and says what was missed, and the loop can
   * be corrected in the next turn for the cost of one sentence. Named for the
   * property the loop cares about rather than for the interface, because
   * `loop.ts` deliberately knows nothing about interfaces — and inferring it
   * from a missing optional callback would hand the behaviour to every embedder
   * that happened not to pass one.
   */
  unattended?: boolean;
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

  // Images ride on a user message after the tool result, because that is the
  // only shape all three providers accept — see `ImageAttachment`. Pushed here,
  // after the result and before the next request, so the model sees the tool's
  // description of the file and the file itself in the order it asked for them.
  const images = takePendingImages();
  if (images.length > 0) {
    messages.push({
      role: "user",
      content:
        images.length === 1
          ? "The image requested above:"
          : `The ${images.length} images requested above:`,
      images,
    });
  }

  return { kind: "continue" };
}

/** Whether the turn is over, or the loop should ask the model once more. */
type TurnEnding = { kind: "continue" } | { kind: "done"; text: string };

/** What the turn may be asked before it is allowed to end. */
interface FinishGates {
  /** Nobody is reading the answer; see AgentLoopOptions.unattended. */
  unattended: boolean;
  /** The turn has tools at all. A conversational turn is given none. */
  useTools: boolean;
  /** This turn set a wall budget, so the deadline is its own to read. */
  wallBudgeted: boolean;
}

/**
 * Decides what happens when the model responds without calling any tool.
 *
 * Usually that means it is finished. Three times it does not: a stream that
 * died mid-sentence has to be resumed, a turn that changed files without
 * checking them is asked once to verify, and an unattended turn with budget to
 * spare is asked once to prove it satisfied what was actually asked for. Each
 * pushes a user message and goes round again, which is why this returns an
 * instruction rather than a value.
 *
 * The two gates are evaluated together and answered with one message, because
 * they are cheap in round trips and expensive in window: a second injection
 * costs one of the six turns the window keeps, and the reason the second gate
 * exists at all is a turn that had lost sight of its own question.
 */
function finishTurn(
  messages: Message[],
  callbacks: AgentCallbacks,
  state: TurnState,
  assistantText: string,
  maxIterations: number,
  gates: FinishGates,
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
  const askToVerify =
    state.hasUnverifiedEdits() &&
    state.verificationReminders < MAX_VERIFICATION_REMINDERS &&
    canAffordAnotherRound(
      state,
      maxIterations,
      VERIFICATION_GATE_MIN_STEPS,
      gates.wallBudgeted,
    );

  // The turn is about to end early, confidently, with most of its budget
  // unspent and nobody to catch a wrong answer. `useTools` is required because
  // a conversational turn is offered no tools at all, and telling it to go run
  // a command would be an instruction it cannot carry out.
  //
  // `windDownWarned` suppresses the gate while the model is under a warning to
  // start nothing new, and that suppression is temporary, not a latch for the
  // turn: `shouldWarnWindDown` clears the flag once the step estimate recovers
  // past twice the threshold, and the gate can fire on a later response in the
  // same turn. Both directions are covered in requirementGate.test.ts.
  const askForRequirements =
    gates.unattended &&
    gates.useTools &&
    state.requirementReminders < MAX_REQUIREMENT_REMINDERS &&
    !state.windDownWarned &&
    canAffordAnotherRound(
      state,
      maxIterations,
      REQUIREMENT_GATE_MIN_STEPS,
      gates.wallBudgeted,
    );

  if (askToVerify || askForRequirements) {
    const asks: string[] = [];
    // The status names every gate that fired, not just the first. One message
    // goes to the model, but this is the live channel — headless writes it to
    // stderr and to the event log — and a run where both fired must not read
    // as a run where only the verification gate did.
    const reasons: string[] = [];

    if (askToVerify) {
      state.verificationReminders++;
      asks.push(VERIFICATION_REMINDER);
      reasons.push("files changed without a check");
    }

    if (askForRequirements) {
      state.noteRequirementGate();
      asks.push(REQUIREMENT_REMINDER);
      reasons.push("finishing early with budget left");
    }

    messages.push({ role: "user", content: asks.join("\n\n") });
    callbacks.onStatus?.(`⚠️  ${reasons.join(", ")} - asking the agent to check its work`);
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
  // The budget for one stretch of work, and the amount each checkpoint grants.
  // Mutable because a turn the user chooses to continue is the same turn: the
  // history, the model's reasoning and the footer's clock all carry on, and
  // nothing has to be re-established.
  const BUDGET_STEP = maxIterations();
  let budget = BUDGET_STEP;
  const planMode = options.planMode === true;
  // Read once per turn, like every other switch here: the finish gates consult
  // it at the end of a turn that may have started under a different caller.
  const unattended = options.unattended === true;
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
  // The second budget, and the one an automated harness actually enforces. Read
  // once per turn for the same reason, and armed before the first request so
  // the clock covers the whole turn rather than starting after it.
  const wallBudget = maxWallSeconds();
  if (wallBudget !== null) setDeadline(wallBudget);

  // Captured before the first request, because afterwards it cannot be
  // recovered: every message the loop pushes is a user message too, and from
  // the array alone the question being answered is indistinguishable from the
  // reminders about answering it.
  const taskIndex = turnInitiatingIndex(messages);

  const state = new TurnState();

  try {
    while (state.iterations < budget) {
      // Checked before the iteration rather than after, so the turn stops with
      // its reserve intact instead of starting a step it cannot finish. Inside
      // the `try`, so it takes the same onError-then-rethrow path the iteration
      // ceiling takes.
      //
      // `onBudgetExhausted` is deliberately not consulted. The ceiling can
      // afford to ask because iterations do not tick while a human thinks; a
      // clock does, and the only path with a handler is the interactive one,
      // which does not set this budget in the first place.
      if (wallBudget !== null && deadlineReached()) {
        throw new WallBudgetExhaustedError(wallBudget);
      }

      // Said to the model and to nobody else. A benchmark trial that exhausted
      // its 200 iterations was still writing at its 198th tool call, because
      // this warning only ever reached stderr — a status callback cannot change
      // what the model does next, and a message in the conversation can.
      //
      // It used to be shown to the user as well, back when reaching the ceiling
      // ended the turn as a failure and a warning was the only notice they got.
      // Now the ceiling asks them directly, so a row saying the turn is nearly
      // over is a worse version of a question they are about to be asked.
      //
      // A flag rather than an equality on the iteration count: two budgets can
      // each come into view, and the equality it replaces silently never fired
      // when the ceiling was below the warning distance.
      const stepsLeft = state.stepsRemaining(budget);
      if (state.shouldWarnWindDown(stepsLeft)) {
        messages.push({
          role: "user",
          // Floored at one: the count can round down to zero or below when the
          // clock is what is binding, and "0 more steps" reads as a turn that
          // is already over to a model that is about to get another one.
          content:
            `Only ${Math.max(stepsLeft, 1)} more steps are available before this turn is stopped. ` +
            `Finish what you have started rather than beginning anything new, ` +
            `make sure the work is in a usable state, and report what is done and ` +
            `what is not.`,
        });
      }

      // Counted after the warning, not before, so `stepsRemaining` reads the
      // steps *completed* and its two budgets agree on what "left" means: the
      // clock's `floor(left / mean)` counts the step about to start, so the
      // iteration term has to as well. Against the equality this replaced
      // (`iterations === budget - 5`, evaluated post-increment) the notice
      // lands one step later and "5 more steps" now includes the one about to
      // run, where it used to mean five *after* it.
      state.iterations++;

      // Measured from the same array that is sent, so the segment sizes and
      // the provider's token count describe one and the same request.
      // Compaction is opt-in; see runtime/compaction.ts for the benchmark that
      // turned it off. When enabled it applies to the request only, because the
      // execution log is built from `messages` after the turn and shrinking
      // what is sent is not the same as forgetting what happened.
      const windowed = recentMessages(messages, MAX_TURNS, taskIndex);
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
          budget,
          { unattended, useTools, wallBudgeted: wallBudget !== null },
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

      // The budget is spent and the turn is still working. Ask before ending
      // it: the work so far is on disk either way, and whether to spend more is
      // the user's call rather than this constant's.
      //
      // Inside the loop rather than after it, so answering `continue` re-enters
      // the same `while` with a raised ceiling instead of restarting anything.
      if (state.iterations >= budget) {
        // No handler means nobody is there to answer, which is not the same as
        // an answer of `stop`. Headless runs rely on this: they never implement
        // it, so exhaustion stays the error their exit code is built on.
        if (!callbacks.onBudgetExhausted) break;

        const decision = await callbacks.onBudgetExhausted({
          steps: state.iterations,
        });

        // No separate abort check: cancelling resolves an open checkpoint as
        // `stop`, so Ctrl+C arrives here as the answer below.
        if (decision === "stop") {
          // Reported as a cancellation because that is what it is: the user
          // stopped a turn that was still going. It also means the turn footer
          // reads `cancelled` rather than `failed` — the controller sets that
          // from this callback — which is the honest word for work that was
          // halted rather than broken.
          callbacks.onCancel?.();
          return "";
        }

        budget += BUDGET_STEP;
        // A turn the user chose to extend has a new end, and deserves the same
        // warning as it comes into view. Without this reset the second stretch
        // would run to its ceiling silently.
        state.windDownWarned = false;
      }
    }

    throw new IterationBudgetExhaustedError(budget);
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
    // Interpreter sessions are scoped to the turn, and this is the only place
    // that runs on every one of its exits — completion, cancellation, an
    // exhausted budget, a provider failure. A session that outlived its turn
    // would answer the next one with variables nobody in that conversation set.
    //
    // Background processes deliberately do not end here: a server started this
    // turn has to still be up for the user in the next one, so `process_stop`
    // and session exit are what end those.
    closeReplSessions();

    // The deadline is module state, so a turn that ended has to disarm it or
    // the next one reads a clock that stopped counting: its wind-down would
    // fire at the first step, and once tool timeouts clamp against this, every
    // command would be cut to a second.
    //
    // Unconditional, including for a turn that armed nothing — "the loop leaves
    // no deadline behind" is the invariant worth having, and it also restores
    // the real clock, so a test that injected one does not leak it into the
    // rest of the run.
    clearDeadline();

    // An image read on the last call before a cancellation is never attached,
    // because the path that attaches them returns before reaching it. Dropping
    // it here is what stops it arriving in the next turn, where it would be
    // introduced as "the image requested above" with no such request in sight.
    takePendingImages();

    // Every exit is a turn that ended and is worth a record: a normal
    // completion, a rejected edit, cancellation, an exhausted budget, a
    // provider failure. A finally is what makes that exactly one record per
    // call regardless of which path got here.
    callbacks.onTurnSummary?.(state.toSummary());
  }
}
