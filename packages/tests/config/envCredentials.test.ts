import { describe, test, expect } from "bun:test";
import { resolveEnvCredentials } from "../../../config/envCredentials";

describe("environment credentials", () => {
  test("no credential variables resolves to null", () => {
    expect(resolveEnvCredentials({})).toBeNull();
  });

  test("a vendor variable implies its provider", () => {
    expect(resolveEnvCredentials({ GEMINI_API_KEY: "k1" })).toEqual({
      provider: "google",
      apiKey: "k1",
      source: "GEMINI_API_KEY",
    });
  });

  test("WOOPCODE_API_KEY takes its provider from WOOPCODE_PROVIDER", () => {
    expect(
      resolveEnvCredentials({
        WOOPCODE_API_KEY: "k2",
        WOOPCODE_PROVIDER: "gemini",
      }),
    ).toEqual({ provider: "gemini", apiKey: "k2", source: "WOOPCODE_API_KEY" });
  });

  test("WOOPCODE_API_KEY without a provider falls back to the default", () => {
    expect(resolveEnvCredentials({ WOOPCODE_API_KEY: "k3" })?.provider).toBe(
      "google",
    );
  });

  test("WOOPCODE_API_KEY wins over vendor variables", () => {
    const resolved = resolveEnvCredentials({
      WOOPCODE_API_KEY: "explicit",
      GEMINI_API_KEY: "vendor",
    });
    expect(resolved?.apiKey).toBe("explicit");
  });

  test("whitespace-only values are ignored, not treated as keys", () => {
    expect(
      resolveEnvCredentials({ GEMINI_API_KEY: "   ", GOOGLE_API_KEY: "real" }),
    ).toEqual({ provider: "google", apiKey: "real", source: "GOOGLE_API_KEY" });
  });

  test("keys are trimmed, so a trailing newline cannot corrupt a header", () => {
    expect(resolveEnvCredentials({ GEMINI_API_KEY: " k4\n" })?.apiKey).toBe("k4");
  });

  // WOOPCODE_PROVIDER is an instruction to this program, so naming a provider
  // it cannot run is a mistake worth reporting at startup rather than failing
  // on the first turn.
  test("WOOPCODE_PROVIDER naming an unrunnable provider is rejected", () => {
    expect(() =>
      resolveEnvCredentials({
        WOOPCODE_API_KEY: "k5",
        WOOPCODE_PROVIDER: "openai",
      }),
    ).toThrow(/no runtime client/);
  });

  test("WOOPCODE_PROVIDER naming a provider that does run is honoured", () => {
    expect(
      resolveEnvCredentials({
        WOOPCODE_API_KEY: "k5b",
        WOOPCODE_PROVIDER: "anthropic",
      }),
    ).toEqual({ provider: "anthropic", apiKey: "k5b", source: "WOOPCODE_API_KEY" });
  });

  test("the rejection names the variable and the fix", () => {
    expect(() =>
      resolveEnvCredentials({
        WOOPCODE_API_KEY: "k6",
        WOOPCODE_PROVIDER: "openai",
      }),
    ).toThrow(/WOOPCODE_API_KEY.*WOOPCODE_PROVIDER/s);
  });

  // A vendor variable is not an instruction to Woopcode. It is almost always
  // exported for another tool that shares the shell, and refusing to start
  // over it stranded users whose own key was already in providers.json.
  test("a vendor key for an unrunnable provider does not stop startup", () => {
    expect(resolveEnvCredentials({ OPENAI_API_KEY: "k8" })).toBeNull();
  });

  // The other half of that rule: a vendor variable for a provider that *does*
  // run is a usable credential, and enabling the provider is what turns the
  // same variable from skipped into honoured.
  test("a vendor key for a runnable provider is used", () => {
    expect(resolveEnvCredentials({ ANTHROPIC_API_KEY: "k7" })).toEqual({
      provider: "anthropic",
      apiKey: "k7",
      source: "ANTHROPIC_API_KEY",
    });
  });

  test("an unrunnable vendor key does not shadow a usable one", () => {
    expect(
      resolveEnvCredentials({
        OPENAI_API_KEY: "other-tool",
        GEMINI_API_KEY: "mine",
      }),
    ).toEqual({ provider: "google", apiKey: "mine", source: "GEMINI_API_KEY" });
  });

  test("WOOPCODE_PROVIDER does not redirect a vendor key to another provider", () => {
    // The variable names its own provider; WOOPCODE_PROVIDER applies only to
    // WOOPCODE_API_KEY, so a Gemini key is never sent to Anthropic — which
    // matters more now that Anthropic is a provider a key could reach.
    expect(
      resolveEnvCredentials({
        GEMINI_API_KEY: "mine",
        WOOPCODE_PROVIDER: "anthropic",
      }),
    ).toEqual({ provider: "google", apiKey: "mine", source: "GEMINI_API_KEY" });
  });
});
