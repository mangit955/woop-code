import { toolRegistery } from "../tools";
import { SYSTEM_PROMPT } from "./systemPrompt";
import type { Message, ProviderClient, ModelResponse } from "./types";

export function geminiClient(apiKey: string): ProviderClient {
  return {
    async generate(messages: Message[]): Promise<ModelResponse> {
      const contents = messages.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      }));
      const tools = [
        {
          functionDeclarations: toolRegistery.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: {
              type: "OBJECT",
              properties: Object.fromEntries(
                tool.parameters.map((param) => [
                  param.name,
                  {
                    type: "STRING",
                    description: param.description,
                  },
                ]),
              ),
              required: tool.parameters
                .filter((param) => param.required)
                .map((param) => param.name),
            },
          })),
        },
      ];
      //console.log(JSON.stringify({ contents, tools }, null, 2));
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text: SYSTEM_PROMPT,
                },
              ],
            },
            contents,
            tools,
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
              functionCall?: {
                name: string;
                args?: Record<string, unknown>;
              };
            }>;
          };
        }>;
      };
      //console.log(JSON.stringify(data, null, 2));

      const part = data.candidates?.[0]?.content?.parts?.[0];

      if (part?.functionCall) {
        return {
          type: "tool_call",
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        } satisfies ModelResponse;
      }

      return {
        type: "message",
        content: part?.text ?? "",
      } satisfies ModelResponse;
    },
  };
}
export function openAIClient(apiKey: string): ProviderClient {
  return {
    async generate(messages: Message[]): Promise<ModelResponse> {
      throw new Error("OpenAI client not implemented yet.");
    },
  };
}
export function anthropicClient(apiKey: string): ProviderClient {
  return {
    async generate(messages: Message[]): Promise<ModelResponse> {
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
