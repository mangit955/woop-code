import { GoogleGenAI, Type } from "@google/genai";
import { toolRegistery } from "../tools";
import { SYSTEM_PROMPT } from "./systemPrompt";
import type { Message, ProviderClient, StreamEvent } from "./types";

export const ACTIVE_PROVIDER_MODELS: Record<string, string> = {
  google: "Gemini 3.5 Flash Lite",
};

export function geminiClient(apiKey: string): ProviderClient {
  const ai = new GoogleGenAI({ apiKey });

  return {
    async *stream(
      messages: Message[],
      repoContext: string,
      signal?: AbortSignal,
    ): AsyncGenerator<StreamEvent> {
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
                  thoughtSignature: message.thoughtSignature,
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
              type: Type.OBJECT,
              properties: Object.fromEntries(
                tool.parameters.map((param) => [
                  param.name,
                  {
                    type: Type.STRING,
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
      // console.time("generateContentStream");
      // console.log("Repo Context:", repoContext.length);
      // console.log("Messages:", JSON.stringify(contents).length);
      // console.log("System:", SYSTEM_PROMPT.length);
      const stream = await ai.models.generateContentStream({
        model: "gemini-3.5-flash-lite",
        contents,

        config: {
          systemInstruction: `${SYSTEM_PROMPT}\n\nRepository Context:\n${repoContext}`,
          tools,
          abortSignal: signal,
        },
      });
      // console.timeEnd("generateContentStream");

      for await (const chunk of stream) {
        // console.time("first-sdk-chunk");
        // console.timeEnd("first-sdk-chunk");
        const part = chunk.candidates?.[0]?.content?.parts?.find(
          (p) => p.functionCall,
        );

        if (part?.functionCall) {
          yield {
            type: "tool_call",
            id: part.functionCall.id ?? crypto.randomUUID(),
            name: part.functionCall.name!,
            arguments: part.functionCall.args ?? {},
            thoughtSignature: part.thoughtSignature,
          };

          continue;
        }
        const text = chunk.text;

        if (text) {
          yield {
            type: "text",
            content: text,
          };
        }
      }

      yield {
        type: "done",
      };
    },
  };
}

export function groqClient(apiKey: string) {}
export function openAIClient(apiKey: string) {}
export function anthropicClient(apiKey: string) {}

export function createProviderClient(
  provider: string,
  apiKey: string,
): ProviderClient {
  switch (provider) {
    case "google":

    case "gemini":
      return geminiClient(apiKey);
    // case "groq":
    //   return groqClient(apiKey);

    // case "openai":
    //   return openAIClient(apiKey);

    // case "anthropic":
    //   return anthropicClient(apiKey);

    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
