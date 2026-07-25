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
      
      // Log token usage for debugging (enable with DEBUG=1 environment variable)
      if (process.env.DEBUG) {
        console.log("Token usage estimate:");
        console.log("  Repo Context:", repoContext.length, "chars");
        console.log("  Messages:", JSON.stringify(contents).length, "chars");
        console.log("  System Prompt:", SYSTEM_PROMPT.length, "chars");
        console.log("  Total:", (repoContext.length + JSON.stringify(contents).length + SYSTEM_PROMPT.length), "chars (~", Math.ceil((repoContext.length + JSON.stringify(contents).length + SYSTEM_PROMPT.length) / 4), "tokens)");
      }
      
      let stream;
      try {
        stream = await ai.models.generateContentStream({
          model: "gemini-3.5-flash-lite",
          contents,

          config: {
            systemInstruction: `${SYSTEM_PROMPT}\n\nRepository Context:\n${repoContext}`,
            tools,
            abortSignal: signal,
          },
        });
      } catch (error: any) {
        // Handle rate limit errors gracefully
        if (error?.status === 429 || error?.code === 429) {
          const errorData = error?.error || error;
          const retryAfter = errorData?.details?.find((d: any) => d['@type']?.includes('RetryInfo'))?.retryDelay || 'a few moments';
          
          throw new Error(
            `⚠️  Rate limit exceeded for Google Gemini API.\n\n` +
            `Please wait ${retryAfter} before trying again, or switch to a different provider.\n\n` +
            `You can:\n` +
            `  • Wait and retry your request\n` +
            `  • Use a different API provider (run 'woopcode providers' to see options)\n` +
            `  • Check your quota at: https://ai.dev/rate-limit`
          );
        }
        
        // Re-throw other errors
        throw error;
      }
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
