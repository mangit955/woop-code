import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_ID } from "../../../providers/client";
import {
  allModels,
  defaultModelForProvider,
  describeStatus,
  findModel,
  findModels,
  formatContextWindow,
  isRunnable,
  modelBelongsToProvider,
  modelStatus,
  providerLabel,
} from "../../../providers/modelCatalog";
import { PROVIDERS } from "../../../providers/providerRegistry";

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
    expect(findModels("Claude Sonnet").map((model) => model.id)).toEqual([
      "claude-sonnet-5",
      "claude-sonnet-4-6",
    ]);
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

  /**
   * Every provider in the registry has a client now, so no row in the catalog
   * is coming-soon. The branch is still the one that runs the moment a model
   * lands for a provider that has not shipped, so it is tested with a model the
   * catalog does not contain — status asks the registry about the provider and
   * nothing else, which is exactly the property worth pinning.
   */
  const unshipped = { id: "zeta-1", provider: "zeta", name: "Zeta 1", contextWindow: 128_000 };

  test("a model on a provider with no client is coming soon", () => {
    // Derived, not stored: nothing in models.json says this.
    expect(modelStatus(unshipped)).toBe("coming-soon");
    expect(describeStatus(modelStatus(unshipped))).toBe("Coming Soon");
  });

  test("every catalogued model is runnable today", () => {
    for (const model of allModels()) {
      expect(isRunnable(model)).toBe(true);
    }
  });

  test("a runnable model is ready", () => {
    expect(modelStatus(google, "something-else")).toBe("ready");
  });

  test("the active model is the default", () => {
    expect(modelStatus(google, google.id)).toBe("default");
  });

  test("being active does not make an unavailable model look ready", () => {
    expect(modelStatus(unshipped, unshipped.id)).toBe("coming-soon");
  });

  test("provider labels come from the registry", () => {
    expect(providerLabel("google")).toBe("Google Gemini");
    expect(providerLabel("openai")).toBe("OpenAI");
    // An unknown id is shown as itself rather than hidden.
    expect(providerLabel("mystery")).toBe("mystery");
  });
});

/**
 * providers.json stores the provider and the model independently, so the two
 * can disagree — a config written before Anthropic existed pairs it with a
 * Gemini id. Sending that to Anthropic is a 404 on the first turn, so both the
 * client factory and the /provider command resolve it through here.
 */
describe("a provider's own model", () => {
  test("every enabled provider has a default that exists and is its own", () => {
    for (const provider of PROVIDERS.filter((provider) => provider.enabled)) {
      const id = defaultModelForProvider(provider.id);

      expect({ provider: provider.id, model: findModel(id)?.provider }).toEqual({
        provider: provider.id,
        model: provider.id,
      });
    }
  });

  test("the Google default is the same one the rest of the code starts on", () => {
    expect(defaultModelForProvider("google")).toBe(DEFAULT_MODEL_ID);
    // The alias the registry and the client factory both accept.
    expect(defaultModelForProvider("gemini")).toBe(DEFAULT_MODEL_ID);
  });

  test("an unknown provider still answers rather than returning nothing", () => {
    expect(defaultModelForProvider("mystery")).toBe(DEFAULT_MODEL_ID);
  });

  test("ownership is what decides whether a selection survives a provider switch", () => {
    expect(modelBelongsToProvider("claude-opus-5", "anthropic")).toBe(true);
    expect(modelBelongsToProvider("claude-opus-5", "google")).toBe(false);
    expect(modelBelongsToProvider(DEFAULT_MODEL_ID, "gemini")).toBe(true);
  });

  test("a model the catalog has never heard of belongs to nobody", () => {
    // It is not claimed for the provider being asked about: the caller decides
    // what to do with an unknown id, and createProviderClient passes it
    // through rather than overriding a model newer than this build.
    expect(modelBelongsToProvider("claude-opus-99", "anthropic")).toBe(false);
    expect(modelBelongsToProvider(undefined, "anthropic")).toBe(false);
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
