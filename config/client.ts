import { GoogleGenAI, Type } from "@google/genai";
import { toolRegistery } from "../tools";
import { SYSTEM_PROMPT } from "./systemPrompt";
import type { Message, ProviderClient, StreamEvent } from "./types";

export const ACTIVE_PROVIDER_MODELS: Record<string, string> = {
  google: "Gemini 3.5 Flash Lite",
};

export const DEFAULT_MODEL_ID = "gemini-3.5-flash-lite";

export const GOOGLE_MODELS = [
  { id: "gemini-3.6-pro", name: "Gemini 3.6 Pro" },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
  { id: "gemini-3.6-flash-lite", name: "Gemini 3.6 Flash Lite" },
  { id: "gemini-3.5-pro", name: "Gemini 3.5 Pro" },
  { id: "gemini-3-pro", name: "Gemini 3 Pro" },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
  { id: "gemini-2.0-flash-lite", name: "Gemini 2.0 Flash Lite" },
] as const;

export function getModelDisplayName(modelId: string | undefined) {
  return GOOGLE_MODELS.find((model) => model.id === modelId)?.name ?? modelId ?? ACTIVE_PROVIDER_MODELS.google;
}

const GEMINI_REQUEST_TIMEOUT_MS = 60_000;

export function geminiClient(
  apiKey: string,
  model = DEFAULT_MODEL_ID,
  ai: Pick<GoogleGenAI, "models"> = new GoogleGenAI({ apiKey }),
): ProviderClient {

  return {
    async *stream(
      messages: Message[],
      repoContext: string,
      signal?: AbortSignal,
      useTools = true,
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
                    type: toolParameterType(param.type),
                    description: param.description,
                    ...(param.type === "array"
                      ? { items: { type: Type.STRING } }
                      : {}),
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
      
      const requestController = new AbortController();
      let timedOut = false;
      const abortFromCaller = () => requestController.abort();
      const timeout = setTimeout(() => {
        timedOut = true;
        requestController.abort();
      }, GEMINI_REQUEST_TIMEOUT_MS);

      if (signal) {
        if (signal.aborted) {
          abortFromCaller();
        } else {
          signal.addEventListener("abort", abortFromCaller, { once: true });
        }
      }

      try {
        const stream = await ai.models.generateContentStream({
          model,
          contents,

          config: {
            systemInstruction: repoContext
              ? `${SYSTEM_PROMPT}\n\nRepository Context:\n${repoContext}`
              : SYSTEM_PROMPT,
            tools: useTools ? tools : undefined,
            abortSignal: requestController.signal,
          },
        });

        for await (const chunk of stream) {
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (part.functionCall) {
              yield {
                type: "tool_call",
                id: part.functionCall.id ?? crypto.randomUUID(),
                name: part.functionCall.name!,
                arguments: part.functionCall.args ?? {},
                thoughtSignature: part.thoughtSignature,
              };
            } else if (part.text) {
              yield { type: "text", content: part.text };
            }
          }

          // Some provider chunks expose text only through the convenience
          // property rather than a content part.
          if (parts.length === 0 && chunk.text) {
            yield { type: "text", content: chunk.text };
          }
        }

        yield {
          type: "done",
        };
      } catch (error: any) {
        if (timedOut) {
          throw new Error(
            "Gemini did not respond within 60 seconds. Check your network connection and API quota, then try again.",
          );
        }

        // Handle rate limit errors gracefully
        if (error?.status === 429 || error?.code === 429) {
          const errorData = error?.error || error;
          const retryAfter = errorData?.details?.find((d: any) => d['@type']?.includes('RetryInfo'))?.retryDelay || 'a few moments';

          throw new Error(
            `⚠️  Rate limit exceeded for Google Gemini API.\n\n` +
            `Please wait ${retryAfter} before trying again.\n\n` +
            `You can:\n` +
            `  • Wait and retry your request\n` +
            `  • Check your quota at: https://ai.dev/rate-limit`,
          );
        }

        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortFromCaller);
      }
    },
  };
}

function toolParameterType(type: string | undefined) {
  switch (type) {
    case "number":
      return Type.NUMBER;
    case "array":
      return Type.ARRAY;
    default:
      return Type.STRING;
  }
}

export function groqClient(apiKey: string) {}
export function openAIClient(apiKey: string) {}
export function anthropicClient(apiKey: string) {}

export function createProviderClient(
  provider: string,
  apiKey: string,
  model?: string,
): ProviderClient {
  switch (provider) {
    case "google":

    case "gemini":
      return geminiClient(apiKey, model);
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
