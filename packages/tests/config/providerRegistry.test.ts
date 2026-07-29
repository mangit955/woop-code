import { describe, test, expect } from "bun:test";
import {
  PROVIDERS,
  enabledProviderIds,
  getEnabledProviders,
  getProviderInfo,
  isProviderEnabled,
  unsupportedProviderMessage,
} from "../../../config/providerRegistry";
import { createProviderClient } from "../../../config/client";
import { loginProvider } from "../../../config/authProvider";

describe("provider registry", () => {
  test("groq is no longer offered", () => {
    expect(getProviderInfo("groq")).toBeUndefined();
    expect(isProviderEnabled("groq")).toBe(false);
  });

  test("only providers with a runtime client are enabled", () => {
    expect(enabledProviderIds()).toEqual(["google"]);
    expect(isProviderEnabled("google")).toBe(true);
    expect(isProviderEnabled("gemini")).toBe(true);
    expect(isProviderEnabled("openai")).toBe(false);
    expect(isProviderEnabled("anthropic")).toBe(false);
  });

  test("every enabled provider can build a client", () => {
    for (const provider of getEnabledProviders()) {
      expect(() => createProviderClient(provider.id, "test-key")).not.toThrow();
    }
  });

  test("planned providers are still listed so users know they are coming", () => {
    const planned = PROVIDERS.filter((provider) => !provider.enabled);
    expect(planned.map((provider) => provider.id)).toEqual([
      "openai",
      "anthropic",
    ]);
  });

  test("the refusal message names the provider and what does work", () => {
    expect(unsupportedProviderMessage("openai")).toContain("not supported yet");
    expect(unsupportedProviderMessage("openai")).toContain("google");
    expect(unsupportedProviderMessage("mistral")).toContain("Unknown provider");
  });
});

describe("gating", () => {
  test("createProviderClient refuses a provider with no client", () => {
    expect(() => createProviderClient("openai", "test-key")).toThrow(
      /not supported yet/,
    );
    expect(() => createProviderClient("groq", "test-key")).toThrow(
      /Unknown provider/,
    );
  });

  test("loginProvider refuses before a key is ever verified", async () => {
    // No network call is made: the registry check happens first, so this
    // resolves instantly rather than hitting the provider's API.
    await expect(loginProvider("openai", "sk-test")).rejects.toThrow(
      /not supported yet/,
    );
    await expect(loginProvider("anthropic", "sk-test")).rejects.toThrow(
      /not supported yet/,
    );
    await expect(loginProvider("groq", "gsk-test")).rejects.toThrow(
      /Unknown provider/,
    );
  });
});
