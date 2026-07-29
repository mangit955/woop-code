import { fetch } from "bun";
import { isProviderEnabled, unsupportedProviderMessage } from "./providerRegistry";

/**
 * Verifies an API key. Providers without a runtime client are refused here so
 * a key can never be stored for a provider that cannot answer a single turn.
 */
export async function loginProvider(provider: string, apiKey: string) {
  if (!isProviderEnabled(provider)) {
    throw new Error(unsupportedProviderMessage(provider));
  }

  switch (provider) {
    case "google":
    case "gemini":
      return verifyGemini(apiKey);
    // Reachable once these flip to enabled in the registry.
    case "openai":
      return verifyOpenai(apiKey);
    case "anthropic":
      return verifyAnthropic(apiKey);
    default:
      throw new Error(unsupportedProviderMessage(provider));
  }
}

async function verifyGemini(apiKey: string) {
  const key = apiKey.trim();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
  );
  return res.ok;
}

async function verifyOpenai(apiKey: string) {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  return res.ok;
}
async function verifyAnthropic(apiKey: string) {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  return res.ok;
}
