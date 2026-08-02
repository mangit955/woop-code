import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { measureSegments } from "../../../config/runtime";
import { recentMessages } from "../../../config/config";
import { SYSTEM_PROMPT } from "../../../config/systemPrompt";
import { parseEvents, replaySteps, type ReplayStep } from "./reconstruct";
import { verifyFixture } from "./generate";

/**
 * The window agentLoop uses. Not exported from the loop, so it is restated
 * here — if the two ever disagree, the faithfulness tests below fail, which is
 * the signal wanted.
 */
const MAX_TURNS = 6;

const FIXTURE_DIR = join(import.meta.dir, "../fixtures/replay");

const fixtures = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".jsonl"))
  .sort();

/** Assembles a step exactly as the loop would, and measures it. */
function assemble(step: ReplayStep) {
  // Only the length of the repository context reaches measurement, and the
  // recording preserves it; the text itself is not needed to reproduce a byte
  // count.
  return measureSegments(
    recentMessages(step.messages, MAX_TURNS),
    "x".repeat(step.repoContextChars),
  );
}

describe("replay corpus", () => {
  test("fixtures are present", () => {
    // A silently empty corpus would make every assertion below vacuous.
    expect(fixtures.length).toBeGreaterThan(0);
  });

  test("the corpus spans more than one recorded trajectory", () => {
    // One trajectory is an anecdote. Context work is validated against the
    // spread, not against whichever run happened to be recorded first.
    expect(fixtures.length).toBeGreaterThan(3);
  });
});

/**
 * The faithfulness proof, and the gate for any future context change.
 *
 * Each `iteration` record carries the `segments` the runtime measured at the
 * time. Reproducing them means the replay assembles the same prompt the real
 * run did, so a later diff against these numbers is attributable to the change
 * under test rather than to the agent having done different work.
 *
 * A deliberate change to assembly will fail this. That is the point:
 * regenerate the fixtures, and the diff is the evidence.
 */
describe.each(fixtures)("%s", (name) => {
  const text = readFileSync(join(FIXTURE_DIR, name), "utf8");
  const steps = replaySteps(parseEvents(text));

  test("reconstruction reproduces every recorded measurement", () => {
    const check = verifyFixture(text);

    // Reported as a list rather than a boolean: a failure should say which
    // iteration diverged and by how much.
    expect(check.mismatches).toEqual([]);
    expect(check.ok).toBe(true);
  });

  test("has iterations to replay", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  test("replaying twice produces identical measurements", () => {
    const first = steps.map(assemble);
    const second = replaySteps(parseEvents(text)).map(assemble);
    expect(second).toEqual(first);
  });

  test("the system prompt is unchanged since the recording", () => {
    // Separate from the assembly assertions on purpose: editing the prompt is
    // a legitimate change that must not read as "assembly drifted".
    expect(SYSTEM_PROMPT.length).toBe(steps[0]!.recordedSegments.systemPrompt!);
  });
});

describe("what the corpus exposes", () => {
  const corpus = fixtures.map((name) => ({
    name,
    steps: replaySteps(parseEvents(readFileSync(join(FIXTURE_DIR, name), "utf8"))),
  }));

  test("the window never engages on a headless run", () => {
    // The defect the context work targets: recentMessages counts *user* turns,
    // and a headless run has one, so every tool result since the start is
    // resent on every iteration.
    for (const { name, steps } of corpus) {
      const last = steps.at(-1)!;
      expect(
        recentMessages(last.messages, MAX_TURNS).length,
        `${name} should retain every message`,
      ).toBe(last.messages.length);
      expect(last.messages.filter((m) => m.role === "user")).toHaveLength(1);
    }
  });

  test("tool results grow while every other segment stays flat", () => {
    for (const { name, steps } of corpus) {
      const first = steps[0]!.recordedSegments;
      const last = steps.at(-1)!.recordedSegments;

      expect(last.toolResults!, `${name} should accumulate tool output`).toBeGreaterThan(
        first.toolResults!,
      );
      expect(last.conversation, `${name} conversation should be flat`).toBe(
        first.conversation,
      );
      expect(last.repoContext, `${name} repoContext should be flat`).toBe(
        first.repoContext,
      );
    }
  });
});
