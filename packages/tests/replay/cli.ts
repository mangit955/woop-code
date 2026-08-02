#!/usr/bin/env bun
/**
 * The replay baseline: prompt assembly measured across every checked-in
 * fixture.
 *
 *   bun run replay:baseline            # whole corpus, summary table
 *   bun run replay:baseline <name>     # one fixture, full detail
 *
 * Produces the same numbers every time from the checked-in recordings, so a
 * future context change can be compared against this baseline without paying
 * for a benchmark run.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { measureSegments } from "../../../config/runtime";
import { recentMessages } from "../../../config/config";
import { parseEvents, replaySteps, type ReplayStep } from "./reconstruct";
import {
  buildReport,
  calibrate,
  observedCache,
  type AssemblyReport,
  type Calibration,
  type ObservedCache,
} from "./report";

const MAX_TURNS = 6;
const FIXTURE_DIR = join(import.meta.dir, "../fixtures/replay");

const current = (step: ReplayStep) =>
  measureSegments(
    recentMessages(step.messages, MAX_TURNS),
    "x".repeat(step.repoContextChars),
  );

interface Measured {
  name: string;
  report: AssemblyReport;
  calibration: Calibration;
  cache: ObservedCache | null;
}

function measureFixture(name: string): Measured | null {
  const events = parseEvents(readFileSync(join(FIXTURE_DIR, name), "utf8"));
  const calibration = calibrate(events);
  // No recorded usage means nothing to calibrate against; reported as skipped
  // rather than estimated with a borrowed ratio.
  if (!calibration) return null;

  return {
    name: name.replace(/\.jsonl$/, ""),
    report: buildReport(replaySteps(events), current, calibration),
    calibration,
    cache: observedCache(events),
  };
}

const n = (v: number) => Math.round(v).toLocaleString();

function printDetail(m: Measured) {
  const { report, calibration, cache } = m;
  console.log(`\n${m.name}`);
  console.log(`  iterations              ${report.iterations}`);
  console.log(
    `  chars/token             ${calibration.charsPerToken.toFixed(2)}  ` +
      `(fitted on totals; ±${(calibration.perIterationError * 100).toFixed(1)}% per iteration)`,
  );

  for (const [label, dist] of [
    ["prompt chars/iteration", report.perIterationChars],
    ["est. tokens/iteration", report.perIterationEstimatedTokens],
    ["tool result chars", report.toolResultChars],
  ] as const) {
    console.log(
      `  ${label.padEnd(24)}mean ${n(dist.mean).padStart(9)}   median ${n(dist.median).padStart(9)}` +
        `   p95 ${n(dist.p95).padStart(9)}   max ${n(dist.max).padStart(9)}`,
    );
  }

  console.log(`  total chars sent        ${n(report.totalChars)}`);
  console.log(`  total est. tokens       ${n(report.estimatedTotalTokens)}`);
  console.log(
    cache
      ? `  cache (observed)        ${(cache.hitRate * 100).toFixed(0)}% of ${n(cache.promptTokens)} prompt tokens`
      : `  cache                   not recorded`,
  );
}

const only = process.argv[2];
const names = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith(".jsonl"))
  .filter((file) => !only || file.includes(only))
  .sort();

if (names.length === 0) {
  console.error(only ? `No fixture matching "${only}".` : "No fixtures found.");
  process.exit(1);
}

const measured = names
  .map(measureFixture)
  .filter((m): m is Measured => m !== null);
const unusable = names.length - measured.length;

if (only && measured.length === 1) {
  printDetail(measured[0]!);
  process.exit(0);
}

console.log(`\nreplay baseline — ${measured.length} fixture(s)\n`);
const head =
  `${"fixture".padEnd(30)}${"iters".padStart(6)}${"peak chars".padStart(12)}` +
  `${"mean chars".padStart(12)}${"p95 chars".padStart(11)}${"ch/tok".padStart(8)}${"cache".padStart(7)}`;
console.log(head);
console.log("-".repeat(head.length));

for (const m of measured) {
  console.log(
    m.name.padEnd(30) +
      String(m.report.iterations).padStart(6) +
      n(m.report.perIterationChars.max).padStart(12) +
      n(m.report.perIterationChars.mean).padStart(12) +
      n(m.report.perIterationChars.p95).padStart(11) +
      m.calibration.charsPerToken.toFixed(2).padStart(8) +
      (m.cache ? `${(m.cache.hitRate * 100).toFixed(0)}%` : "n/a").padStart(7),
  );
}

// Peak context is the figure a windowing change has to move, so its spread
// across the corpus is what says whether any single fixture is representative.
const peaks = measured
  .map((m) => m.report.perIterationChars.max)
  .sort((a, b) => a - b);
const mid = (xs: number[]) =>
  xs.length % 2
    ? xs[(xs.length - 1) / 2]!
    : (xs[xs.length / 2 - 1]! + xs[xs.length / 2]!) / 2;

console.log(`\npeak prompt characters across the corpus`);
console.log(
  `  mean    ${n(peaks.reduce((a, b) => a + b, 0) / peaks.length).padStart(12)}`,
);
console.log(`  median  ${n(mid(peaks)).padStart(12)}`);
console.log(`  min     ${n(peaks[0]!).padStart(12)}`);
console.log(`  max     ${n(peaks.at(-1)!).padStart(12)}`);

console.log(
  `\ntotals   ${n(measured.reduce((s, m) => s + m.report.totalChars, 0))} chars sent, ` +
    `${n(measured.reduce((s, m) => s + m.report.estimatedTotalTokens, 0))} estimated tokens ` +
    `over ${measured.reduce((s, m) => s + m.report.iterations, 0)} iterations`,
);

console.log(
  `\nCache rates are provider-observed for these recordings only. A modified\n` +
    `assembly cannot have its cache rate derived from them: implicit caching\n` +
    `depends on prefix stability, and rewriting earlier messages may lower the\n` +
    `hit rate rather than preserve it.`,
);

if (unusable > 0) {
  console.log(`\n${unusable} fixture(s) had no usage data and were skipped.`);
}
