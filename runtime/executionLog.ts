import type { Message } from "../config/types";
import { toolEffect } from "./toolEffects";

/**
 * A one-line record of something the agent did.
 *
 * The runtime used to discard every one of these at the turn boundary.
 * AgentController passes a copy of the conversation into agentLoop, the loop
 * fills that copy with tool calls and their results, and on return only the
 * final assistant text is kept — so on the next turn the model saw
 * `user → assistant → user` and nothing about what it had read, edited or run.
 * It repeated work and forgot discoveries not because the window was small but
 * because the record was deleted.
 *
 * Keeping the raw transcript instead would be the other extreme: tool output
 * was the entire measured growth of the prompt, 0 to 87,630 characters across a
 * benchmark run, while every other segment stayed flat. So what survives a turn
 * is one line per action — what was done, to what, and how it came out.
 */
export interface ExecutionRecord {
  iteration: number;
  tool: string;
  /** The argument that identifies the target: a path, a command, a pattern. */
  subject: string;
  /** Compacted outcome — never the raw output. */
  outcome: string;
}

/** Arguments consulted, in order, to describe what a call acted on. */
const SUBJECT_KEYS = ["path", "filePath", "file", "command", "pattern", "query"];

function subjectOf(args: Record<string, unknown>): string {
  for (const key of SUBJECT_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Characters of a compacted outcome. One line, not a summary of the output. */
const MAX_OUTCOME_CHARS = 120;

/**
 * Reduces a tool result to its outcome.
 *
 * Mechanical rather than model-written: a summarising call would make the same
 * transcript produce different context on a rerun, which is the determinism the
 * runtime is supposed to keep. Every rule here is a truncation or a count.
 */
export function compactOutcome(tool: string, output: string): string {
  const text = output.trim();
  if (!text) return "no output";

  if (text.startsWith("Tool failed:")) {
    return text.slice(0, MAX_OUTCOME_CHARS);
  }

  const lines = text.split("\n");

  switch (toolEffect(tool)) {
    case "read":
      // The content is not worth keeping — the agent can read it again. What
      // matters is that it looked, and how much was there.
      return `${lines.length} line${lines.length === 1 ? "" : "s"}`;

    case "write":
      return text.slice(0, MAX_OUTCOME_CHARS);

    case "shell": {
      // The last non-empty line is where a test summary, a build error and a
      // stack trace's root cause all land.
      const last = [...lines].reverse().find((line) => line.trim());
      return (last ?? text).trim().slice(0, MAX_OUTCOME_CHARS);
    }

    default:
      return text.slice(0, MAX_OUTCOME_CHARS);
  }
}

/**
 * Builds execution records from the messages a turn produced.
 *
 * Reads the conversation the loop mutated, so it needs nothing new threaded
 * through the runtime — the information was always there and was being thrown
 * away.
 */
export function recordsFrom(
  messages: Message[],
  startIteration = 1,
): ExecutionRecord[] {
  const records: ExecutionRecord[] = [];
  const pending = new Map<string, { tool: string; subject: string }>();
  let iteration = startIteration;

  for (const message of messages) {
    if (message.role === "assistant_tool_call") {
      pending.set(message.toolCallId, {
        tool: message.toolName,
        subject: subjectOf(message.arguments),
      });
      continue;
    }

    if (message.role !== "tool") continue;

    const call = pending.get(message.toolCallId);
    if (!call) continue;
    pending.delete(message.toolCallId);

    records.push({
      iteration: iteration++,
      tool: call.tool,
      subject: call.subject,
      outcome: compactOutcome(call.tool, message.content),
    });
  }

  return records;
}

/** Share of the prompt budget the execution log may occupy. */
export const EXECUTION_LOG_BUDGET_RATIO = 0.05;

/**
 * Renders records into a bounded block, newest kept first.
 *
 * Bounded by characters rather than by a record count: twenty file reads and
 * twenty long shell commands are not the same amount of context, and a count
 * would let the second silently cost several times the first.
 */
export function renderExecutionLog(
  records: ExecutionRecord[],
  budgetChars: number,
): string {
  if (records.length === 0 || budgetChars <= 0) return "";

  const kept: string[] = [];
  let used = 0;

  // Oldest entries drop first: what the agent did most recently is what it
  // needs to not repeat.
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]!;
    const line = `  ${record.tool}${record.subject ? ` ${record.subject}` : ""} → ${record.outcome}`;

    if (used + line.length + 1 > budgetChars) break;

    kept.unshift(line);
    used += line.length + 1;
  }

  if (kept.length === 0) return "";

  const dropped = records.length - kept.length;

  return (
    `Work already done in this session` +
    `${dropped > 0 ? ` (${dropped} earlier action${dropped === 1 ? "" : "s"} omitted)` : ""}` +
    ` — do not repeat it:\n${kept.join("\n")}`
  );
}
