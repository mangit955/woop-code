#!/usr/bin/env bun
/**
 * Builds replay fixtures from recorded Harbor runs.
 *
 *   bun packages/tests/replay/generate.ts [jobsDir]
 *
 * `jobs/` is gitignored, so fixtures have to be checked in for the benchmark to
 * be reproducible from a clean clone. This script is what produced them, and
 * rerunning it against the same recordings must produce the same files.
 *
 * A recording is copied verbatim rather than re-serialised. Re-encoding the
 * JSON inflated it by 2% through separator differences alone, and a fixture
 * that is not byte-identical to what the runtime wrote is a worse record of
 * what happened.
 *
 * Nothing is written unless the reconstruction reproduces the recording's own
 * measurements exactly. A fixture that cannot do that is not evidence of
 * anything, so it is reported and skipped rather than accepted.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { Glob } from "bun";
import { measureSegments } from "../../../config/runtime";
import { recentMessages } from "../../../config/config";
import { parseEvents, replaySteps } from "./reconstruct";

/** The window agentLoop uses; see the note in assembly.replay.test.ts. */
const MAX_TURNS = 6;

const REPO = join(import.meta.dir, "../../..");
const OUT = join(import.meta.dir, "../fixtures/replay");

/** Short, stable names so a fixture says which run and task it came from. */
const RUN_SLUGS: Record<string, string> = {
  "woopcode-terminal-bench-2": "tb2",
  "baseline-pre-1.1": "pre11",
};

export interface FixtureCheck {
  ok: boolean;
  iterations: number;
  mismatches: string[];
}

/**
 * Replays a recording and compares every iteration against what the runtime
 * measured at the time.
 *
 * `conversation` and `toolResults` are the segments assembly determines, so
 * they are the ones that prove the reconstruction faithful. systemPrompt and
 * repoContext are inputs, not products, and are checked separately by the test
 * suite so that editing the system prompt cannot read as assembly drift.
 */
export function verifyFixture(text: string): FixtureCheck {
  const steps = replaySteps(parseEvents(text));
  const mismatches: string[] = [];

  for (const step of steps) {
    const measured = measureSegments(
      recentMessages(step.messages, MAX_TURNS),
      "x".repeat(step.repoContextChars),
    );

    for (const key of ["conversation", "toolResults"] as const) {
      const recorded = step.recordedSegments[key];
      if (recorded !== undefined && measured[key] !== recorded) {
        mismatches.push(
          `iteration ${step.iteration}: ${key} replayed ${measured[key]}, recorded ${recorded}`,
        );
      }
    }
  }

  return { ok: mismatches.length === 0, iterations: steps.length, mismatches };
}

if (import.meta.main) {
  const jobsDir = process.argv[2] ?? join(REPO, "jobs");
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  const logs: string[] = [];
  for await (const rel of new Glob("*/*/agent/woopcode-events.jsonl").scan(jobsDir)) {
    logs.push(join(jobsDir, rel));
  }
  logs.sort();

  let written = 0;
  let skipped = 0;

  for (const log of logs) {
    const trialDir = basename(dirname(dirname(log)));
    const runDir = basename(dirname(dirname(dirname(log))));
    const task = trialDir.replace(/__.*$/, "");
    const slug = RUN_SLUGS[runDir] ?? runDir.replace(/[^a-z0-9]+/gi, "-");
    const name = `${slug}-${task}.jsonl`;

    const text = readFileSync(log, "utf8");
    const check = verifyFixture(text);

    if (!check.ok) {
      skipped++;
      console.error(`✖ ${name}: ${check.mismatches.length} mismatch(es), not written`);
      for (const m of check.mismatches.slice(0, 3)) console.error(`    ${m}`);
      continue;
    }

    if (check.iterations === 0) {
      skipped++;
      console.error(`✖ ${name}: no replayable iterations, not written`);
      continue;
    }

    writeFileSync(join(OUT, name), text);
    written++;
    console.log(`✓ ${name}  ${check.iterations} iterations`);
  }

  console.log(`\n${written} fixture(s) written, ${skipped} skipped.`);
  if (skipped > 0) process.exitCode = 1;
}
