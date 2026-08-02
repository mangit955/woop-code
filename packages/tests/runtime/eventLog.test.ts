import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createEventLog, now } from "../../../runtime/eventLog";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "woopcode-eventlog-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readEvents(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("event log", () => {
  test("no path yields a log that discards writes", () => {
    const log = createEventLog(undefined);
    expect(() => log.write({ type: "run_end", ts: now(), ok: true })).not.toThrow();
  });

  test("events are written as one JSON object per line", () => {
    const path = join(dir, "events.jsonl");
    const log = createEventLog(path);

    log.write({
      type: "run_start",
      ts: now(),
      model: "m",
      version: "1",
      prompt: "p",
    });
    log.write({ type: "run_end", ts: now(), ok: true });

    const events = readEvents(path);
    expect(events.map((e) => e.type)).toEqual(["run_start", "run_end"]);
    expect(events[0]?.prompt).toBe("p");
  });

  // The log is opened before the run and must not retain a previous run's
  // events, or a harness would attribute stale steps to the current trial.
  test("opening truncates an existing log", () => {
    const path = join(dir, "events.jsonl");

    createEventLog(path).write({ type: "run_end", ts: now(), ok: false });
    createEventLog(path).write({ type: "run_end", ts: now(), ok: true });

    const events = readEvents(path);
    expect(events).toHaveLength(1);
    expect(events[0]?.ok).toBe(true);
  });

  test("missing parent directories are created", () => {
    const path = join(dir, "nested", "deeper", "events.jsonl");
    createEventLog(path).write({ type: "run_end", ts: now(), ok: true });
    expect(readEvents(path)).toHaveLength(1);
  });

  // One runaway tool output must not make the log unusable.
  test("long strings are truncated with a marker", () => {
    const path = join(dir, "events.jsonl");
    createEventLog(path).write({
      type: "tool_result",
      ts: now(),
      id: "1",
      name: "read_file",
      output: "x".repeat(300_000),
    });

    const output = readEvents(path)[0]?.output as string;
    expect(output.length).toBeLessThan(300_000);
    expect(output).toContain("truncated");
  });

  // Each record is flushed as it happens, so a run killed at a timeout still
  // leaves every completed step on disk.
  test("records are readable before the run ends", () => {
    const path = join(dir, "events.jsonl");
    const log = createEventLog(path);
    log.write({ type: "text", ts: now(), text: "partial" });

    expect(readEvents(path)).toHaveLength(1);
  });

  test("an unwritable path degrades to a no-op instead of throwing", () => {
    const log = createEventLog(join(dir, "events.jsonl", "impossible", "x.jsonl"));
    expect(() => log.write({ type: "run_end", ts: now(), ok: true })).not.toThrow();
  });

  test("timestamps are ISO 8601", () => {
    expect(now()).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  /**
   * Harbor reads this log from Python, by string key, in
   * harbor_woopcode/agent.py (`_aggregate_usage` and
   * `populate_context_post_run`). Nothing type-checks across that boundary, so
   * renaming a field here would silently stop the benchmark reporting tokens
   * rather than fail. These two tests are the contract; change them and
   * harbor_woopcode/test_agent.py together or not at all.
   */
  test("an iteration record keeps the field names Harbor reads", () => {
    const path = join(dir, "events.jsonl");
    const log = createEventLog(path);

    log.write({
      type: "iteration",
      ts: now(),
      n: 1,
      usage: {
        promptTokens: 1000,
        completionTokens: 20,
        cachedTokens: 600,
        totalTokens: 1020,
      },
      segments: {
        systemPrompt: 2400,
        repoContext: 800,
        conversation: 40,
        toolResults: 0,
      },
      toolCalls: 1,
      durationMs: 900,
    });

    const [record] = readEvents(path);
    expect(Object.keys(record!).sort()).toEqual([
      "durationMs",
      "n",
      "segments",
      "toolCalls",
      "ts",
      "type",
      "usage",
    ]);
    expect(Object.keys(record!.usage as object).sort()).toEqual([
      "cachedTokens",
      "completionTokens",
      "promptTokens",
      "totalTokens",
    ]);
    expect(Object.keys(record!.segments as object).sort()).toEqual([
      "conversation",
      "repoContext",
      "systemPrompt",
      "toolResults",
    ]);
  });

  test("a run_end summary keeps the field names Harbor reads", () => {
    const path = join(dir, "events.jsonl");
    const log = createEventLog(path);

    log.write({
      type: "run_end",
      ts: now(),
      ok: true,
      summary: {
        iterations: 2,
        retries: 0,
        toolCalls: 1,
        lastWriteStep: 1,
        lastShellStep: undefined,
        toolCounts: { create_file: 1 },
        unverifiedEdits: true,
      },
    });

    const [record] = readEvents(path);
    const summary = record!.summary as Record<string, unknown>;
    expect(summary.unverifiedEdits).toBe(true);
    expect(Object.keys(summary).sort()).toEqual([
      "iterations",
      "lastWriteStep",
      "retries",
      "toolCalls",
      "toolCounts",
      "unverifiedEdits",
    ]);
  });

  test("a retry record keeps the field names Harbor reads", () => {
    const path = join(dir, "events.jsonl");
    const log = createEventLog(path);

    log.write({
      type: "retry",
      ts: now(),
      attempt: 1,
      delayMs: 750,
      reason: "transient failure",
      error: "The socket connection was closed unexpectedly",
    });

    const [record] = readEvents(path);
    expect(Object.keys(record!).sort()).toEqual([
      "attempt",
      "delayMs",
      "error",
      "reason",
      "ts",
      "type",
    ]);
  });
});
