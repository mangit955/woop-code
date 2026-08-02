import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { measureSegments } from "../../../config/runtime";
import { recentMessages } from "../../../config/config";
import { parseEvents, replaySteps } from "./reconstruct";
import {
  buildReport,
  calibrate,
  distribution,
  estimateTokens,
  observedCache,
} from "./report";

const FIXTURE = join(import.meta.dir, "../fixtures/replay/tb2-overfull-hbox.jsonl");
const events = parseEvents(readFileSync(FIXTURE, "utf8"));
const steps = replaySteps(events);

describe("calibration", () => {
  test("derives chars-per-token from the recording, not from a constant", () => {
    const calibration = calibrate(events)!;

    expect(calibration).not.toBeNull();
    expect(calibration.samples).toBe(steps.length);
    // The removed `length / 4` estimator was wrong by a third. The measured
    // ratio is content-dependent and nowhere near 4.
    expect(calibration.charsPerToken).toBeGreaterThan(1.5);
    expect(calibration.charsPerToken).toBeLessThan(4);
  });

  test("publishes its own per-iteration error rather than implying precision", () => {
    const calibration = calibrate(events)!;
    // Known and stated: the ratio drifts through a run, so a single iteration
    // carries several percent of error even though totals are exact.
    expect(calibration.perIterationError).toBeGreaterThan(0);
    expect(calibration.perIterationError).toBeLessThan(0.2);
  });

  test("a recording without usage yields no calibration rather than a guess", () => {
    const withoutUsage = events.map((e) =>
      e.type === "iteration" ? { ...e, usage: undefined } : e,
    );
    expect(calibrate(withoutUsage)).toBeNull();
  });

  test("totals round-trip exactly against the recorded token counts", () => {
    const calibration = calibrate(events)!;
    const iterations = events.filter(
      (e) => e.type === "iteration" && (e.usage as { promptTokens?: number })?.promptTokens,
    );
    const chars = iterations.reduce(
      (sum, e) =>
        sum + Object.values(e.segments as Record<string, number>).reduce((a, b) => a + b, 0),
      0,
    );
    const actual = iterations.reduce(
      (sum, e) => sum + (e.usage as { promptTokens: number }).promptTokens,
      0,
    );

    // Fitting on totals makes the total exact by construction. This is the
    // number the report leads with, so it is the one that must not drift.
    expect(Math.abs(estimateTokens(chars, calibration) - actual) / actual).toBeLessThan(0.01);
  });

  test("a single early iteration is the estimator's worst case", () => {
    const calibration = calibrate(events)!;
    const first = events.find((e) => e.type === "iteration")!;
    const chars = Object.values(first.segments as Record<string, number>).reduce(
      (a, b) => a + b,
      0,
    );
    const actual = (first.usage as { promptTokens: number }).promptTokens;

    // Documented rather than hidden: before any tool output arrives the prompt
    // is prose, which tokenizes far more densely than the run's average.
    expect(estimateTokens(chars, calibration)).toBeLessThan(actual);
  });
});

describe("distribution", () => {
  test("reports the shape, not just the average", () => {
    // A run whose mean looks fine can still spend its last third near a
    // ceiling; p95 and max are where that shows.
    const d = distribution([1, 2, 3, 4, 100]);
    expect(d.median).toBe(3);
    expect(d.max).toBe(100);
    expect(d.p95).toBe(100);
    expect(d.mean).toBe(22);
  });

  test("an empty sample is zeroed rather than throwing", () => {
    expect(distribution([])).toEqual({ mean: 0, median: 0, p95: 0, max: 0 });
  });
});

describe("observed cache", () => {
  test("reports what the provider actually reported", () => {
    const cache = observedCache(events);
    if (cache) {
      expect(cache.hitRate).toBeGreaterThanOrEqual(0);
      expect(cache.hitRate).toBeLessThanOrEqual(1);
      expect(cache.cachedTokens).toBeLessThanOrEqual(cache.promptTokens);
    }
  });

  test("a recording without usage yields nothing", () => {
    const withoutUsage = events.map((e) =>
      e.type === "iteration" ? { ...e, usage: undefined } : e,
    );
    expect(observedCache(withoutUsage)).toBeNull();
  });
});

describe("assembly report", () => {
  const calibration = calibrate(events)!;

  function currentAssembly(step: (typeof steps)[number]) {
    return measureSegments(
      recentMessages(step.messages, 6),
      "x".repeat(step.repoContextChars),
    );
  }

  test("measures the run the recording captured", () => {
    const report = buildReport(steps, currentAssembly, calibration);

    expect(report.iterations).toBe(steps.length);
    expect(report.totalChars).toBeGreaterThan(0);
    expect(report.estimatedTotalTokens).toBeGreaterThan(0);
    // p95 above median is the growth this whole programme is about.
    expect(report.perIterationChars.p95).toBeGreaterThan(
      report.perIterationChars.median,
    );
  });

  test("a candidate strategy is measured on identical inputs", () => {
    // The point of the harness: two strategies over one recorded trajectory,
    // so the difference is the strategy rather than the agent doing different
    // work.
    const capped = (step: (typeof steps)[number]) => {
      const segments = currentAssembly(step);
      return { ...segments, toolResults: Math.min(segments.toolResults, 40_000) };
    };

    const before = buildReport(steps, currentAssembly, calibration);
    const after = buildReport(steps, capped, calibration);

    expect(after.totalChars).toBeLessThan(before.totalChars);
    expect(after.toolResultChars.max).toBeLessThanOrEqual(40_000);
  });
});
