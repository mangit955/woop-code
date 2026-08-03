import type { Message } from "../config/types";
import { compactOutcome } from "./executionLog";

/**
 * Shrinking the tool history a request carries, without changing its shape.
 *
 * Measured across ten recorded benchmark trajectories, tool history is the only
 * part of the prompt that grows: peak prompt size ran from 22,639 to 219,179
 * characters while the system prompt, repository context and conversation
 * stayed flat.
 *
 * The obvious fix — drop the oldest messages until the prompt fits — was tried
 * against those recordings first and is unsafe. It would have dropped the task
 * instruction itself in 568 iterations, leaving the agent working without
 * knowing what it had been asked, and orphaned 217 tool results from the calls
 * that produced them, which is not a shape the provider is given anywhere else.
 *
 * So nothing is removed. Old entries keep their place in the conversation and
 * lose only their payload: a result becomes its outcome, an argument keeps its
 * head. The model still sees that it read that file and ran that command, in
 * order, and only stops seeing the bulk. That reduced total characters by 43%
 * across the corpus against 54% for dropping, which is a good trade for
 * removing both failure modes.
 */

/**
 * Compaction is off unless `WOOPCODE_TOOL_HISTORY_BUDGET` asks for it.
 *
 * It does what it claims to: replayed against the recorded corpus it cut peak
 * prompt characters by 36-43% at matched depth, and a live benchmark confirmed
 * the reduction. It was still turned off, because the same benchmark cost a
 * task that had been passing.
 *
 * Against the previous run of the same five tasks:
 *
 *   circuit-fibsqrt   1.0 at 165 iterations  ->  0.0, budget exhausted at 200
 *   build-pov-ray     1.0 at  79 iterations  ->  finished at 121, +53%
 *   make-mips         0.0 at 200 iterations  ->  0.0, finished at 183
 *
 * One regression, no improvement, and two trajectories that needed materially
 * more iterations to reach the same place. Fewer characters per request bought
 * more requests.
 *
 * The likeliest explanation is that compacting call arguments removes content
 * the agent authored: circuit-fibsqrt builds a 28,017-line file through tool
 * arguments, which are 86% of its tool history, and it is the task that
 * regressed. That is a hypothesis, not a finding — at n=1 it cannot be
 * separated from ordinary variance, and there was no budget left to try.
 *
 * So the code, its tests and the measurements stay, and the default does not.
 * Enabling it is one environment variable, and the replay harness will report
 * what any budget would do without spending anything:
 *
 *     WOOPCODE_TOOL_HISTORY_BUDGET=40000
 *
 * Before enabling it again, the thing worth testing is compacting results only
 * and leaving authored arguments intact — measured at -21% across the corpus,
 * and it cannot remove anything the agent wrote.
 */
export const SUGGESTED_TOOL_HISTORY_BUDGET = 40_000;

/**
 * Characters of each argument value kept when an old call is compacted.
 *
 * Enough to preserve what the call *was* — which file, which command — because
 * that is the part the next iteration reasons about. The payload of a write or
 * an inline script is what makes arguments grow: on one trajectory they were
 * 86% of the tool history, a single argument reaching 8,800 characters.
 */
const ARGUMENT_HEAD_CHARS = 200;

/**
 * The configured budget, or null when compaction is disabled.
 *
 * Null rather than a very large number: "off" is a decision backed by a
 * benchmark, and it should read that way at the call site instead of being
 * hidden behind a threshold nothing ever crosses.
 */
export function toolHistoryBudget(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env.WOOPCODE_TOOL_HISTORY_BUDGET?.trim();
  if (!raw) return null;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    process.stderr.write(
      `⚠️  ignoring WOOPCODE_TOOL_HISTORY_BUDGET=${raw} (expected a non-negative integer)\n`,
    );
    return null;
  }
  return parsed;
}

/** Replaces oversized argument values with their head and a note. */
function compactArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(args)) {
    compacted[name] =
      typeof value === "string" && value.length > ARGUMENT_HEAD_CHARS
        ? `${value.slice(0, ARGUMENT_HEAD_CHARS)}… [${
            value.length - ARGUMENT_HEAD_CHARS
          } more characters omitted]`
        : value;
  }

  return compacted;
}

/** The characters a message contributes to the tool history. */
function historySize(message: Message): number {
  if (message.role === "assistant_tool_call") {
    return JSON.stringify(message.arguments).length;
  }
  return message.role === "tool" ? message.content.length : 0;
}

/**
 * Returns the messages to send, with tool history older than `budgetChars`
 * reduced to its outcomes.
 *
 * Never mutates the input. The caller keeps the full results — the execution
 * log is built from them after the turn, and compacting the record of what
 * happened is not the same as compacting what is sent.
 *
 * A budget of 0 compacts everything except the most recent entry; the newest
 * is always kept whole, because a turn that cannot see the result it just
 * received cannot act on it.
 */
export function compactToolHistory(
  messages: Message[],
  budgetChars: number,
): Message[] {
  const compacted = messages.slice();
  let used = 0;
  let keptAny = false;

  for (let i = compacted.length - 1; i >= 0; i--) {
    const message = compacted[i]!;
    const size = historySize(message);
    if (size === 0) continue;

    if (!keptAny || used + size <= budgetChars) {
      used += size;
      keptAny = true;
      continue;
    }

    if (message.role === "tool") {
      compacted[i] = {
        ...message,
        content: compactOutcome(message.toolName, message.content),
      };
    } else if (message.role === "assistant_tool_call") {
      // thoughtSignature is carried through untouched: it belongs to the turn
      // the model took, not to the payload being trimmed.
      compacted[i] = { ...message, arguments: compactArguments(message.arguments) };
    }
  }

  return compacted;
}
