import { toolRegistery } from "../tools";
import { SYSTEM_PROMPT } from "./systemPrompt";
import type { Message, ProviderClient, ModelResponse } from "./types";

export function geminiClient(apiKey: string): ProviderClient {
  return {
    async generate(
      messages: Message[],
      repoContext: string,
    ): Promise<ModelResponse> {
      const contents = messages.map((message) => {
        switch (message.role) {
          case "user":
            return {
              role: "user",
              parts: [{ text: message.content }],
            };

          case "assistant":
            return {
              role: "model",
              parts: [{ text: message.content }],
            };

          case "assistant_tool_call":
            return {
              role: "model",
              parts: [
                {
                  functionCall: {
                    id: message.toolCallId,
                    name: message.toolName,
                    args: message.arguments,
                  },
                },
              ],
            };

          case "tool":
            return {
              role: "user",
              parts: [
                {
                  functionResponse: {
                    name: message.toolName,
                    response: {
                      result: message.content,
                    },
                  },
                },
              ],
            };
        }
      });
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
      console.log(JSON.stringify({ contents, tools }, null, 2));
      const body = {
        contents,
        tools,
      };

      console.log("Request size:", JSON.stringify(body).length, "bytes");

      console.log(JSON.stringify(body, null, 2));
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
                  text: `${SYSTEM_PROMPT}\n\nRepository Context:\n${repoContext}`,
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
      console.log(JSON.stringify(data, null, 2));

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
    async generate(
      messages: Message[],
      repoContext: string,
    ): Promise<ModelResponse> {
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
        if (message.role === "assistant_tool_call") {
          return {
            role: "assistant",
            tool_calls: [
              {
                id: message.toolCallId,
                type: "function",
                function: {
                  name: message.toolName,
                  arguments: JSON.stringify(message.arguments),
                },
              },
            ],
          };
        }
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
          content: "content" in message ? message.content : "",
        };
      });

      // // Detailed debug logging
      // console.log("\n========== GROQ REQUEST ==========");
      // console.log("Model:", "openai/gpt-oss-20b");
      // console.log("System prompt length:", SYSTEM_PROMPT.length);
      // console.log("Conversation messages:", apiMessages.length);
      // console.log(
      //   "Conversation size:",
      //   JSON.stringify(apiMessages).length,
      //   "bytes",
      // );
      // console.log("Tools:", tools.length);
      // console.log("Tool schema size:", JSON.stringify(tools).length, "bytes");

      const requestBody = {
        model: "openai/gpt-oss-20b",
        messages: [
          {
            role: "system",
            content: `${SYSTEM_PROMPT}\n\nRepository Context:\n${repoContext}`,
          },
          ...apiMessages,
        ],
        tools,
        tool_choice: "auto",
      };

      // console.log(
      //   "Total request size:",
      //   JSON.stringify(requestBody).length,
      //   "bytes",
      // );

      // console.log(
      //   "Approx prompt characters:",
      //   SYSTEM_PROMPT.length + JSON.stringify(apiMessages).length,
      // );

      const res = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
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

      // console.log("\n========== GROQ RESPONSE ==========");
      // console.log(JSON.stringify(data, null, 2));

      const choice = data.choices[0];

      if (!choice) {
        throw new Error("Groq returned no choices.");
      }

      const message = choice.message;

      const tool = message.tool_calls?.[0];

      if (tool) {
        // console.log("Tool requested:", tool.function.name);
        // console.log("Arguments:", tool.function.arguments);
        return {
          type: "tool_call",
          id: tool.id,
          name: tool.function.name,
          arguments: JSON.parse(tool.function.arguments),
        } satisfies ModelResponse;
      }

      // console.log("Assistant response:");
      // console.log(message.content);
      return {
        type: "message",
        content: message.content ?? "",
      };
    },
  };
}

export function openAIClient(apiKey: string): ProviderClient {
  return {
    async generate(
      messages: Message[],
      repoContext: string,
    ): Promise<ModelResponse> {
      throw new Error("OpenAI client not implemented yet.");
    },
  };
}
export function anthropicClient(apiKey: string): ProviderClient {
  return {
    async generate(
      messages: Message[],
      repoContext: string,
    ): Promise<ModelResponse> {
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
