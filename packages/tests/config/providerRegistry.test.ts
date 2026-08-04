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
    expect(enabledProviderIds()).toEqual(["google", "openai", "anthropic"]);
    expect(isProviderEnabled("google")).toBe(true);
    expect(isProviderEnabled("gemini")).toBe(true);
    expect(isProviderEnabled("anthropic")).toBe(true);
    expect(isProviderEnabled("openai")).toBe(true);
  });

  test("every enabled provider can build a client", () => {
    for (const provider of getEnabledProviders()) {
      expect(() => createProviderClient(provider.id, "test-key")).not.toThrow();
    }
  });

  test("the refusal message names the provider and what does work", () => {
    expect(unsupportedProviderMessage("openai")).toContain("not supported yet");
    expect(unsupportedProviderMessage("openai")).toContain("google");
    expect(unsupportedProviderMessage("mistral")).toContain("Unknown provider");
  });
});

describe("gating", () => {
  /**
   * A provider may be listed without being runnable — that is what `enabled`
   * is for, and the interface shows it as coming soon rather than pretending it
   * works. Nothing is in that state today, now that every listed provider has a
   * client, so this iterates rather than naming one: it pins the rule so the
   * next provider added is refused at both gates rather than left half-wired.
   */
  test("a listed provider with no client is refused by both gates", async () => {
    for (const provider of PROVIDERS.filter((entry) => !entry.enabled)) {
      expect(() => createProviderClient(provider.id, "test-key")).toThrow(
        /not supported yet/,
      );
      await expect(loginProvider(provider.id, "test-key")).rejects.toThrow(
        /not supported yet/,
      );
    }
  });

  test("an unknown provider is refused before a key is ever verified", async () => {
    expect(() => createProviderClient("groq", "test-key")).toThrow(
      /Unknown provider/,
    );
    // No network call is made: the registry check happens first, so this
    // resolves instantly rather than hitting a provider's API.
    await expect(loginProvider("groq", "gsk-test")).rejects.toThrow(
      /Unknown provider/,
    );
  });
});
