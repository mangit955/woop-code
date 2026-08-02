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
});
