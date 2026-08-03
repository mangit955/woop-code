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

/**
 * Assembles a step the way the recordings were made: windowed, uncompacted.
 *
 * Deliberately not the current runtime path. These fixtures were recorded
 * before compaction existed, so reproducing them proves the *reconstruction*
 * faithful — which is what makes the corpus usable as a baseline. What the
 * runtime assembles today is reported by `bun run replay:baseline`, which
 * measures both and shows the difference.
 */
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

  test("was recorded with the corpus-wide system prompt", () => {
    // Separate from the assembly assertions on purpose: editing the prompt is
    // a legitimate change that must not read as "assembly drifted".
    //
    // This used to compare the recording against the *current* prompt, which
    // made every prompt edit fail until the fixtures were re-recorded — and
    // re-recording costs a live benchmark run. So the check is that the corpus
    // is internally consistent: every fixture carries the same system prompt
    // size, which is what makes the replay numbers comparable across fixtures.
    // How far today's prompt has moved from that is asserted once, below.
    expect(steps[0]!.recordedSegments.systemPrompt).toBe(RECORDED_SYSTEM_PROMPT_CHARS);
  });
});

/**
 * The system prompt every fixture in the corpus was recorded with.
 *
 * Pinned rather than derived, so that a change to the recordings is as visible
 * as a change to the prompt.
 */
const RECORDED_SYSTEM_PROMPT_CHARS = 3_763;

describe("the system prompt against the corpus", () => {
  test("today's prompt differs from the recordings by a known amount", () => {
    // Replay reports characters per iteration, and the system prompt is carried
    // whole on every one of them. So any difference here multiplies straight
    // through the totals: at the time of writing, +391 characters across 932
    // recorded iterations is the entire +364,412 the baseline moved by.
    //
    // Update this deliberately when the prompt changes, and state the delta in
    // the commit — that is the whole point of the number.
    const delta = SYSTEM_PROMPT.length - RECORDED_SYSTEM_PROMPT_CHARS;
    expect(delta).toBe(391);
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
