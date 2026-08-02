import { GoogleGenAI, Type } from "@google/genai";
import { toolRegistery } from "../tools";
import { SYSTEM_PROMPT } from "./systemPrompt";
import type { Message, ProviderClient, StreamEvent, TokenUsage } from "./types";
import { unsupportedProviderMessage } from "./providerRegistry";
import { classifyFailure, delay, maxAttempts } from "../runtime/retry";

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
  injected?: Pick<GoogleGenAI, "models">,
): ProviderClient {
  // Built on the first request rather than here. As a default argument this ran
  // whenever a client was constructed, which made merely naming a provider do
  // the SDK's setup work — and that is not free: it reads the environment and
  // can reach for credentials, so a caller that only wanted to know a provider
  // is available paid for a network client and could block waiting for one.
  // Constructing a client should cost nothing until it is used.
  let ai = injected;
  const sdk = () => (ai ??= new GoogleGenAI({ apiKey }));

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

      const limit = maxAttempts();

      // Retrying is only safe while nothing has been observed. Once a chunk has
      // been yielded the caller has already appended it to the assistant's text
      // and streamed it to the terminal, so starting the request again would
      // duplicate output that the user has watched arrive. A failure after that
      // point is re-thrown for the loop to salvage.
      for (let attempt = 1; ; attempt++) {
        let emittedModelOutput = false;

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
          const stream = await sdk().models.generateContentStream({
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

          // Gemini reports usage on chunks as the response accumulates, with the
          // final chunk carrying the complete figures. Keep the last one seen
          // rather than the first: an early chunk reports a partial completion
          // count, and a stream that ends without usage at all leaves this
          // undefined, which is reported as unknown instead of as zero.
          let usage: TokenUsage | undefined;

          for await (const chunk of stream) {
            if (chunk.usageMetadata) {
              usage = {
                promptTokens: chunk.usageMetadata.promptTokenCount,
                completionTokens: chunk.usageMetadata.candidatesTokenCount,
                cachedTokens: chunk.usageMetadata.cachedContentTokenCount,
                totalTokens: chunk.usageMetadata.totalTokenCount,
              };
            }

            const parts = chunk.candidates?.[0]?.content?.parts ?? [];
            for (const part of parts) {
              if (part.functionCall) {
                emittedModelOutput = true;
                yield {
                  type: "tool_call",
                  id: part.functionCall.id ?? crypto.randomUUID(),
                  name: part.functionCall.name!,
                  arguments: part.functionCall.args ?? {},
                  thoughtSignature: part.thoughtSignature,
                };
              } else if (part.text) {
                emittedModelOutput = true;
                yield { type: "text", content: part.text };
              }
            }

            // Some provider chunks expose text only through the convenience
            // property rather than a content part.
            if (parts.length === 0 && chunk.text) {
              emittedModelOutput = true;
              yield { type: "text", content: chunk.text };
            }
          }

          yield {
            type: "done",
            usage,
          };
          return;
        } catch (error: any) {
          // The caller cancelled the turn. Not a failure, and never retried.
          if (signal?.aborted) throw error;

          const failure = timedOut
            ? new Error(
                "Gemini did not respond within 60 seconds. Check your network connection and API quota, then try again.",
              )
            : error;

          if (!emittedModelOutput) {
            const decision = classifyFailure(failure, attempt, limit);

            if (decision.retry) {
              yield {
                type: "retry",
                attempt,
                delayMs: decision.delayMs,
                reason: decision.reason,
                error: failure instanceof Error ? failure.message : String(failure),
              };

              clearTimeout(timeout);
              signal?.removeEventListener("abort", abortFromCaller);
              await delay(decision.delayMs, signal);
              continue;
            }
          }

          if (timedOut) {
            throw failure;
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
      }
    },
  };
}

function toolParameterType(type: string | undefined) {
  switch (type) {
    case "number":
      return Type.NUMBER;
    case "boolean":
      return Type.BOOLEAN;
    case "array":
      return Type.ARRAY;
    default:
      return Type.STRING;
  }
}

export function createProviderClient(
  provider: string,
  apiKey: string,
  model?: string,
): ProviderClient {
  switch (provider) {
    case "google":
    case "gemini":
      return geminiClient(apiKey, model);

    default:
      // Providers listed as disabled in the registry are refused at login and
      // provider-selection time, so reaching here means a config written by an
      // older version (or by hand).
      throw new Error(unsupportedProviderMessage(provider));
  }
}
