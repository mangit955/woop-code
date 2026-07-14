import type { Message, ProviderClient } from "./types";

export function geminiClient(apiKey: string): ProviderClient {
  return {
    async generate(messages: Message[]) {
      const contents = messages.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      }));
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contents,
          }),
        },
      );

      if (!res.ok) {
        throw new Error(await res.text());
      }

      const data = (await res.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
            }>;
          };
        }>;
      };

      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    },
  };
}
export function openAIClient(apiKey: string): ProviderClient {
  return {
    async generate(prompt: string) {
      throw new Error("OpenAI client not implemented yet.");
    },
  };
}
export function anthropicClient(apiKey: string): ProviderClient {
  return {
    async generate(prompt: string) {
      throw new Error("Anthropic client not implemented yet.");
    },
  };
}

export function createProviderClient(
  provider: string,
  apiKey: string,
): ProviderClient {
  switch (provider) {
    case "google":

    case "gemini":
      return geminiClient(apiKey);

    case "openai":
      return openAIClient(apiKey);

    case "anthropic":
      return anthropicClient(apiKey);

    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
