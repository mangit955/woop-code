import { describe, expect, test } from "bun:test";
import { formatContextMeter } from "./statusBar";
import { DEFAULT_MODEL_ID, findModel } from "../../providers/modelCatalog";

/**
 * The meter reads a model out of the catalog, so it is tested against the
 * catalog rather than an invented window — a percentage is only meaningful
 * against the real denominator, and that number lives in models.json.
 */
describe("the context meter", () => {
  const contextWindow = findModel(DEFAULT_MODEL_ID)!.contextWindow;

  test("reports the prompt against the window it has to fit in", () => {
    const meter = formatContextMeter(contextWindow / 2, DEFAULT_MODEL_ID);

    expect(meter).toContain("50%");
    expect(meter).toContain(`/${formatted(contextWindow)}`);
  });

  test("rounds an empty context to nothing rather than hiding it", () => {
    expect(formatContextMeter(0, DEFAULT_MODEL_ID)).toContain("0%");
  });

  test("says nothing at all for a model the catalog does not know", () => {
    // The alternative is a confident percentage against a guessed window, which
    // is worse than no meter: it reads exactly like a measurement.
    expect(formatContextMeter(50_000, "some-unreleased-model")).toBeUndefined();
    expect(formatContextMeter(50_000, null)).toBeUndefined();
  });

  test("never claims more than a full window", () => {
    expect(formatContextMeter(contextWindow * 3, DEFAULT_MODEL_ID)).toContain("100%");
  });

  function formatted(tokens: number) {
    return tokens >= 1_000_000
      ? `${Number((tokens / 1_000_000).toFixed(1))}M`
      : `${Number((tokens / 1_000).toFixed(1))}K`;
  }
});
