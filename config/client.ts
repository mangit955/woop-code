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
      // console.log(JSON.stringify({ contents, tools }, null, 2));
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
                id: string;
                name: string;
                args?: Record<string, unknown>;
              };
            }>;
          };
        }>;
      };
      // console.log(JSON.stringify(data, null, 2));

      const part = data.candidates?.[0]?.content?.parts?.[0];

      if (part?.functionCall) {
        return {
          type: "tool_call",
          id: part.functionCall.id ?? `gemini-${Date.now()}`,
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

export function groqClient(apiKey: string): ProviderClient {
  return {
    async generate(messages: Message[]): Promise<ModelResponse> {
      const tools = toolRegistery.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: "object",
            properties: Object.fromEntries(
              tool.parameters.map((param) => [
                param.name,
                {
                  type: "string",
                  description: param.description,
                },
              ]),
            ),
            required: tool.parameters
              .filter((p) => p.required)
              .map((p) => p.name),
          },
        },
      }));

      const apiMessages = messages.map((message) => {
        if (message.role === "tool") {
          return {
            role: "tool",
            tool_call_id: (message as any).toolCallId,
            name: (message as any).toolName,
            content: message.content,
          };
        }

        return {
          role: message.role,
          content: message.content,
        };
      });

      const res = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "openai/gpt-oss-20b", // or openai/gpt-oss-120b
            messages: [
              {
                role: "system",
                content: SYSTEM_PROMPT,
              },
              ...apiMessages,
            ],
            tools,
            tool_choice: "auto",
          }),
        },
      );

      if (!res.ok) {
        throw new Error(await res.text());
      }

      const data = (await res.json()) as {
        choices: Array<{
          message: {
            content?: string;
            tool_calls?: Array<{
              id: string;
              function: {
                name: string;
                arguments: string;
              };
            }>;
          };
        }>;
      };

      const choice = data.choices[0];

      if (!choice) {
        throw new Error("Groq returned no choices.");
      }

      const message = choice.message;

      const tool = message.tool_calls?.[0];

      if (tool) {
        return {
          type: "tool_call",
          id: tool.id,
          name: tool.function.name,
          arguments: JSON.parse(tool.function.arguments),
        } satisfies ModelResponse;
      }

      return {
        type: "message",
        content: message.content ?? "",
      };
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
    case "groq":
      return groqClient(apiKey);

    case "openai":
      return openAIClient(apiKey);

    case "anthropic":
      return anthropicClient(apiKey);

    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
