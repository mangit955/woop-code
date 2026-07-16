import { fetch } from "bun";

export async function loginProvider(provider: string, apiKey: string) {
  switch (provider) {
    case "google":
      return verifyGemini(apiKey);
    case "groq":
      return verifyGroq(apiKey);
    case "openai":
      return verifyOpenai(apiKey);
    case "anthropic":
      return verifyAnthropic(apiKey);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

async function verifyGemini(apiKey: string) {
  const key = apiKey.trim();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
  );
  return res.ok;
}

async function verifyGroq(apiKey: string) {
  const key = apiKey.trim();
  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: {
      Authorization: `Bearer ${key}`,
    },
  });
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
