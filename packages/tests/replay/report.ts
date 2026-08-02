import type { PromptSegments } from "../../../config/types";
import type { RunEventRecord, ReplayStep } from "./reconstruct";

/**
 * Turning replayed character counts into numbers an experiment can be read
 * against.
 *
 * Deliberately not `length / 4`. That estimator was removed from the runtime
 * for being wrong by a third, and reintroducing it here to interpret
 * experiments would put the same error back where it does the most damage.
 * Instead the ratio is measured: every recorded iteration carries both the
 * segment sizes and the provider's own token count, so the fixture calibrates
 * its own estimator.
 *
 * The ratio is content-dependent — across the benchmark it ranged from 1.85
 * chars/token on a video task to 3.18 on a LaTeX one — so a ratio borrowed
 * from a different recording would be a guess again. Calibration is per
 * fixture, and the spread is reported so a reader can see how much to trust it.
 */
export interface Calibration {
  /** Total recorded characters divided by total recorded tokens. */
  charsPerToken: number;
  /**
   * Mean absolute percentage error when the ratio is applied to a single
   * iteration. Published because the estimator is worst exactly where a reader
   * might not expect: early iterations are prose-heavy and tokenize densely,
   * later ones are dominated by command output and tokenize sparsely. On the
   * benchmark fixture the ratio drifts from 1.68 to 3.29 across a run.
   */
  perIterationError: number;
  samples: number;
}

/**
 * Fits the ratio on totals rather than by averaging per-iteration ratios.
 *
 * Averaging ratios gives every iteration equal weight, so the small, unusual
 * early ones distort a figure that is mostly used for totals — measured at
 * 3.48% error against the recording. Fitting on totals is exact for totals
 * (0.00%) and happens to be better per-iteration too.
 */
export function calibrate(events: RunEventRecord[]): Calibration | null {
  const pairs: Array<[chars: number, tokens: number]> = [];

  for (const event of events) {
    if (event.type !== "iteration") continue;
    const usage = event.usage as { promptTokens?: number } | undefined;
    const segments = event.segments as Record<string, number> | undefined;
    if (!usage?.promptTokens || !segments) continue;

    const chars = Object.values(segments).reduce((sum, n) => sum + n, 0);
    if (chars > 0) pairs.push([chars, usage.promptTokens]);
  }

  if (pairs.length === 0) return null;

  const totalChars = pairs.reduce((sum, [chars]) => sum + chars, 0);
  const totalTokens = pairs.reduce((sum, [, tokens]) => sum + tokens, 0);
  const charsPerToken = totalChars / totalTokens;

  const perIterationError =
    pairs.reduce(
      (sum, [chars, tokens]) =>
        sum + Math.abs(Math.round(chars / charsPerToken) - tokens) / tokens,
      0,
    ) / pairs.length;

  return { charsPerToken, perIterationError, samples: pairs.length };
}

/** Estimated prompt tokens. An estimate, and labelled as one everywhere. */
export function estimateTokens(chars: number, calibration: Calibration): number {
  return Math.round(chars / calibration.charsPerToken);
}

export interface Distribution {
  mean: number;
  median: number;
  p95: number;
  max: number;
}

/**
 * Percentile by nearest-rank on the sorted sample.
 *
 * Mean alone hides the shape that matters here: prompt size grows through a
 * run, so a run whose mean looks acceptable can still spend its final third
 * near a ceiling. p95 and max are where that shows.
 */
export function distribution(values: number[]): Distribution {
  if (values.length === 0) return { mean: 0, median: 0, p95: 0, max: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;

  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    median: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1)!,
  };
}

/**
 * Cache behaviour as the provider actually reported it during the recording.
 *
 * Only ever the observed run. A different assembly cannot have its cache rate
 * estimated from here: implicit caching depends on prefix stability, and any
 * change that rewrites earlier messages may reduce the hit rate rather than
 * preserve it. That number has to be measured against the provider, not
 * derived — which is precisely why it belongs in a paid experiment and not in
 * this report.
 */
export interface ObservedCache {
  promptTokens: number;
  cachedTokens: number;
  hitRate: number;
}

export function observedCache(events: RunEventRecord[]): ObservedCache | null {
  let prompt = 0;
  let cached = 0;
  let seen = false;

  for (const event of events) {
    if (event.type !== "iteration") continue;
    const usage = event.usage as
      | { promptTokens?: number; cachedTokens?: number }
      | undefined;
    if (!usage?.promptTokens) continue;
    seen = true;
    prompt += usage.promptTokens;
    cached += usage.cachedTokens ?? 0;
  }

  if (!seen) return null;
  return { promptTokens: prompt, cachedTokens: cached, hitRate: cached / prompt };
}

export interface AssemblyReport {
  iterations: number;
  /** Total characters sent across the run, by segment and overall. */
  totalChars: number;
  estimatedTotalTokens: number;
  perIterationChars: Distribution;
  perIterationEstimatedTokens: Distribution;
  toolResultChars: Distribution;
}

/**
 * Measures an assembly strategy over a replayed run.
 *
 * `assemble` is the strategy under test: given a step, return the segments it
 * would produce. Passing the current assembly reproduces the recording;
 * passing a candidate shows what would change, on identical inputs.
 */
export function buildReport(
  steps: ReplayStep[],
  assemble: (step: ReplayStep) => PromptSegments,
  calibration: Calibration,
): AssemblyReport {
  const perIteration: number[] = [];
  const toolResults: number[] = [];

  for (const step of steps) {
    const segments = assemble(step);
    perIteration.push(
      segments.systemPrompt +
        segments.repoContext +
        segments.conversation +
        segments.toolResults,
    );
    toolResults.push(segments.toolResults);
  }

  const totalChars = perIteration.reduce((a, b) => a + b, 0);

  return {
    iterations: steps.length,
    totalChars,
    estimatedTotalTokens: estimateTokens(totalChars, calibration),
    perIterationChars: distribution(perIteration),
    perIterationEstimatedTokens: distribution(
      perIteration.map((chars) => estimateTokens(chars, calibration)),
    ),
    toolResultChars: distribution(toolResults),
  };
}
