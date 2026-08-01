import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_ID } from "../../../config/client";
import {
  allModels,
  describeStatus,
  findModel,
  findModels,
  formatContextWindow,
  isRunnable,
  modelStatus,
  providerLabel,
} from "../../../config/modelCatalog";
import { PROVIDERS } from "../../../config/providerRegistry";

/**
 * The catalog is hand-edited data, and hand-edited data drifts: this file
 * shipped with a duplicated row, a `claud-` typo in an id, and context windows
 * written as strings. Fixing those once would only have bought time — these
 * assertions are what stop the next one reaching a user.
 */
describe("the model catalog is well formed", () => {
  const models = allModels();

  test("lists models at all", () => {
    expect(models.length).toBeGreaterThan(0);
  });

  test("every id is unique", () => {
    const ids = models.map((model) => model.id);

    expect(ids).toEqual([...new Set(ids)]);
  });

  test("every id is lowercase and kebab-cased", () => {
    for (const model of models) {
      expect({ id: model.id, valid: /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(model.id) }).toEqual({
        id: model.id,
        valid: true,
      });
    }
  });

  test("every model names a provider the registry knows", () => {
    const known = new Set(PROVIDERS.map((provider) => provider.id));

    for (const model of models) {
      expect({ id: model.id, provider: model.provider, known: known.has(model.provider) }).toEqual({
        id: model.id,
        provider: model.provider,
        known: true,
      });
    }
  });

  test("every context window is a positive number", () => {
    for (const model of models) {
      // Strings here would spread into every consumer as `number | string`.
      expect({ id: model.id, type: typeof model.contextWindow }).toEqual({
        id: model.id,
        type: "number",
      });
      expect(model.contextWindow).toBeGreaterThan(0);
    }
  });

  test("every model has a display name", () => {
    for (const model of models) {
      expect(model.name.trim()).not.toBe("");
    }
  });

  test("models are grouped by provider", () => {
    // Not sorted — grouped: a reader should never meet the same provider twice.
    const seen = new Set<string>();
    let previous = "";

    for (const model of models) {
      if (model.provider !== previous) {
        expect({ id: model.id, repeated: seen.has(model.provider) }).toEqual({
          id: model.id,
          repeated: false,
        });
        seen.add(model.provider);
        previous = model.provider;
      }
    }
  });

  test("the default model exists in the catalog", () => {
    // A default pointing at a missing id fails on the first turn, not at boot.
    expect(findModel(DEFAULT_MODEL_ID)).toBeDefined();
  });

  test("the default model can actually run", () => {
    expect(isRunnable(findModel(DEFAULT_MODEL_ID)!)).toBe(true);
  });
});

describe("finding models", () => {
  test("an exact id resolves to just that model", () => {
    expect(findModels("gemini-3.5-flash").map((model) => model.id)).toEqual([
      "gemini-3.5-flash",
    ]);
  });

  test("a fragment filters rather than failing", () => {
    const ids = findModels("gpt").map((model) => model.id);

    expect(ids).toContain("gpt-5.5");
    expect(ids.every((id) => id.includes("gpt"))).toBe(true);
  });

  test("a family name returns the family", () => {
    const flash = findModels("flash");

    expect(flash.length).toBeGreaterThan(1);
    expect(flash.every((model) => model.id.includes("flash"))).toBe(true);
  });

  test("a version fragment returns that version", () => {
    expect(findModels("3.5").every((model) => model.id.includes("3.5"))).toBe(true);
  });

  test("matching is case-insensitive and covers display names", () => {
    expect(findModels("Claude Sonnet").map((model) => model.id)).toEqual(["claude-sonnet-4"]);
  });

  test("an empty query is everything", () => {
    expect(findModels("  ")).toEqual(allModels());
  });

  test("an unmatched query is empty, not everything", () => {
    expect(findModels("no-such-model")).toEqual([]);
  });
});

describe("status comes from the provider registry", () => {
  const google = findModel("gemini-3.5-flash")!;
  const openai = findModel("gpt-5.5")!;

  test("a model on a disabled provider is coming soon", () => {
    // Derived, not stored: nothing in models.json says this.
    expect(modelStatus(openai)).toBe("coming-soon");
    expect(describeStatus(modelStatus(openai))).toBe("Coming Soon");
  });

  test("a runnable model is ready", () => {
    expect(modelStatus(google, "something-else")).toBe("ready");
  });

  test("the active model is the default", () => {
    expect(modelStatus(google, google.id)).toBe("default");
  });

  test("being active does not make an unavailable model look ready", () => {
    expect(modelStatus(openai, openai.id)).toBe("coming-soon");
  });

  test("provider labels come from the registry", () => {
    expect(providerLabel("google")).toBe("Google Gemini");
    expect(providerLabel("openai")).toBe("OpenAI");
    // An unknown id is shown as itself rather than hidden.
    expect(providerLabel("mystery")).toBe("mystery");
  });
});

describe("formatting a context window", () => {
  test.each([
    [1_000_000, "1M"],
    [2_000_000, "2M"],
    [1_500_000, "1.5M"],
    [400_000, "400K"],
    [200_000, "200K"],
    [8_192, "8.2K"],
    [512, "512"],
  ])("%i reads as %s", (tokens, expected) => {
    expect(formatContextWindow(tokens)).toBe(expected);
  });
});
