import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { IterationUsage, TurnSummary } from "../config/types";

/**
 * A newline-delimited JSON record of one headless run.
 *
 * Harbor (and any other harness) needs to reconstruct what the agent did, not
 * just what it finally said. Stdout alone cannot carry that: it interleaves
 * prose with tool chatter and has no structure to parse. A separate JSONL
 * stream keeps stdout human-readable while giving machines an exact,
 * append-only record.
 *
 * Records are flushed synchronously as they happen. A run that is killed at a
 * timeout still leaves every event up to that moment on disk, which is what
 * makes a timed-out trial diagnosable instead of empty.
 */
export type RunEvent =
  | { type: "run_start"; ts: string; model: string; version: string; prompt: string }
  | { type: "text"; ts: string; text: string }
  | { type: "tool_call"; ts: string; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; ts: string; id: string; name: string; output: string }
  | { type: "tool_error"; ts: string; id: string; name: string; error: string }
  | { type: "status"; ts: string; text: string }
  | {
      type: "retry";
      ts: string;
      /** 1-based count of attempts already made when this one failed. */
      attempt: number;
      delayMs: number;
      reason: string;
      error: string;
    }
  | {
      type: "iteration";
      ts: string;
      /** 1-based index of the completed loop iteration. */
      n: number;
      /** Provider-reported token counts; absent when the provider reports none. */
      usage?: IterationUsage["usage"];
      /** Prompt segment sizes in characters — see PromptSegments. */
      segments: IterationUsage["segments"];
      toolCalls: number;
      durationMs: number;
    }
  | { type: "error"; ts: string; message: string }
  | {
      type: "run_end";
      ts: string;
      ok: boolean;
      /**
       * What the turn did. Absent only if the loop never started — a headless
       * run is one turn, so there is otherwise exactly one of these.
       */
      summary?: TurnSummary;
    };

/** Caps a single field so one runaway tool output cannot dominate the log. */
const MAX_FIELD_CHARS = 200_000;

function truncate(text: string): string {
  if (text.length <= MAX_FIELD_CHARS) return text;
  const dropped = text.length - MAX_FIELD_CHARS;
  return `${text.slice(0, MAX_FIELD_CHARS)}\n…[truncated ${dropped} characters]`;
}

export interface EventLog {
  write(event: RunEvent): void;
}

/** An event log that discards everything, used when no path is configured. */
const NOOP_LOG: EventLog = { write() {} };

/**
 * Opens a JSONL event log at `path`, truncating any previous contents.
 *
 * Logging is best-effort by design: a benchmark run must not fail because a
 * log directory is read-only. A write error disables the log and reports it
 * once on stderr rather than aborting the turn.
 */
export function createEventLog(path: string | undefined): EventLog {
  if (!path) return NOOP_LOG;

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  } catch (error) {
    process.stderr.write(
      `✖ could not open event log ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return NOOP_LOG;
  }

  let disabled = false;

  return {
    write(event: RunEvent) {
      if (disabled) return;
      try {
        appendFileSync(path, `${JSON.stringify(event, replaceLongStrings)}\n`);
      } catch (error) {
        disabled = true;
        process.stderr.write(
          `✖ event log write failed, continuing without it: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    },
  };
}

/** Applies the field cap during serialisation so every string is bounded. */
function replaceLongStrings(_key: string, value: unknown): unknown {
  return typeof value === "string" ? truncate(value) : value;
}

/** Timestamp helper so every event carries a comparable ISO 8601 instant. */
export function now(): string {
  return new Date().toISOString();
}
