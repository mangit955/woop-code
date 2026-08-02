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

  // A key for a provider with no runtime client must be refused up front
  // rather than stored and failed on the first turn.
  test("a provider with no runtime client is rejected", () => {
    expect(() => resolveEnvCredentials({ OPENAI_API_KEY: "k5" })).toThrow(
      /no runtime client/,
    );
  });

  test("the rejection names the variable and the fix", () => {
    expect(() => resolveEnvCredentials({ ANTHROPIC_API_KEY: "k6" })).toThrow(
      /ANTHROPIC_API_KEY.*WOOPCODE_PROVIDER/s,
    );
  });
});
