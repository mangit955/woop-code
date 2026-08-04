import { GoogleGenAI, Type } from "@google/genai";
import { toolRegistery } from "../tools";
import { SYSTEM_PROMPT } from "./systemPrompt";
import type { Message, ProviderClient, StreamEvent, TokenUsage, Tool } from "./types";
import { toolInputSchema, type JsonSchema, type JsonSchemaType } from "./toolSchema";
import { unsupportedProviderMessage } from "./providerRegistry";
import { classifyFailure, delay, maxAttempts } from "../runtime/retry";
import {
  DEFAULT_MODEL_ID,
  defaultModelForProvider,
  findModel,
  modelBelongsToProvider,
} from "./modelCatalog";
import { anthropicClient } from "./anthropicClient";

export const ACTIVE_PROVIDER_MODELS: Record<string, string> = {
  google: "Gemini 3.5 Flash Lite",
};

// Owned by the catalog now — re-exported because much of the codebase imports
// it from here, and the module it lives in is an implementation detail.
export { DEFAULT_MODEL_ID };

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

/**
 * A model's name as a user should read it.
 *
 * Resolved through the catalog rather than the Gemini list above, which named
 * only Google's models: with a second provider enabled, that list answered
 * "Claude Opus 5" with the raw id in every status line and footer.
 */
export function getModelDisplayName(modelId: string | undefined) {
  return findModel(modelId ?? "")?.name ?? modelId ?? ACTIVE_PROVIDER_MODELS.google;
}

/**
 * How long a single provider request may take.
 *
 * Sixty seconds was chosen against interactive use, where a request that has
 * stopped producing output is a hang the user is sitting through. It is the
 * wrong number for a long task: terminal-bench allows an hour per task, and a
 * response that is still streaming at sixty seconds is progress, not a stall.
 */
const GEMINI_REQUEST_TIMEOUT_MS = 300_000;

/** Thinking budget when nothing overrides it. -1 asks the model to decide. */
const DEFAULT_THINKING_BUDGET = -1;

/**
 * Resolves the reasoning budget, allowing `WOOPCODE_THINKING_BUDGET` to set it.
 *
 * The request previously carried no thinking configuration at all, which left
 * the decision to whatever the model defaults to. Across a five-task benchmark
 * run that produced mean completions of 65 to 372 tokens per iteration — the
 * model was answering reflexively, one tool call at a time, on tasks whose
 * failure mode was arriving at the wrong number rather than running the wrong
 * command.
 *
 * The default is -1 (AUTOMATIC) rather than a token count: what a useful budget
 * is depends on the model, and inventing a number here would be a guess
 * presented as a setting. A probe of 15 requests over this client — five budgets
 * across three prompt sizes, unique prompts, shuffled order — backs that up:
 *
 *   budget    thinking tokens returned
 *   128       0
 *   512       0
 *   1024      54-101
 *   -1        64-202
 *
 * A budget below roughly a thousand is not honoured, it is ignored, so setting
 * one buys the cost of looking configured and none of the reasoning.
 *
 * Thinking is also cheap here, which was worth knowing before assuming
 * otherwise: 494 thinking tokens across all 15 requests, and in the warm steady
 * state the thinking budgets were no slower than sending no config at all.
 *
 * Which values a model accepts is also model-dependent, and not in a way the
 * SDK's types express. `gemini-3.5-flash-lite` — the default here — rejects a
 * budget of 0 outright:
 *
 *     400 INVALID_ARGUMENT: Request contains an invalid argument.
 *
 * So 0 is not a portable way to ask for the old, thinking-free behaviour, and
 * it is not offered as one. It is still accepted here rather than screened out,
 * because a model that does support disabling thinking should be reachable
 * through the same knob; the provider's own error is the honest answer for one
 * that does not.
 *
 * `off` is the portable way, and it is why this returns `undefined` rather than
 * only a number: the caller then sends no `thinkingConfig` at all, which is
 * exactly the request this client made before thinking was configurable. Since
 * the model that ships as the default refuses 0, without `off` there would be no
 * way back to that behaviour — and no control to measure the new one against.
 */
export function thinkingBudget(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env.WOOPCODE_THINKING_BUDGET?.trim();
  if (!raw) return DEFAULT_THINKING_BUDGET;
  if (raw.toLowerCase() === "off") return undefined;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < -1) {
    process.stderr.write(
      `⚠️  ignoring WOOPCODE_THINKING_BUDGET=${raw} (expected off, -1, 0, or a positive integer)\n`,
    );
    return DEFAULT_THINKING_BUDGET;
  }
  return parsed;
}

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
      offeredTools: readonly Tool[] = toolRegistery,
    ): AsyncGenerator<StreamEvent> {
      const contents = buildContents(messages);
      const tools = [
        {
          functionDeclarations: offeredTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: geminiSchema(toolInputSchema(tool)),
          })),
        },
      ];

      const limit = maxAttempts();
      // Read once per turn, for the same reason the loop reads its own budgets
      // once: two requests of one turn should not assemble to different rules.
      const budget = thinkingBudget();

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
              // Omitted entirely when the budget is off, rather than sent as a
              // zero: this model rejects a zero budget, and an absent config is
              // the request this client made before thinking existed.
              ...(budget === undefined ? {} : { thinkingConfig: { thinkingBudget: budget } }),
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
                // Reported apart from the answer, so a run with thinking
                // enabled otherwise looks like one that barely responded: the
                // first benchmark trial after enabling it recorded completions
                // of 22 to 55 tokens while the model was thinking for minutes.
                // Without this, nothing in the logs says what that cost.
                thoughtTokens: chunk.usageMetadata.thoughtsTokenCount,
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
              } else if (part.text && !part.thought) {
                // A thought part is reasoning, not the answer. Yielding it would
                // stream the model's scratchpad to the terminal and persist it
                // as assistant text. Only possible since thinking was enabled,
                // and only if a caller asks for thoughts to be included.
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

type ToolCallMessage = Extract<Message, { role: "assistant_tool_call" }>;

function functionCallPart(message: ToolCallMessage) {
  return {
    functionCall: {
      id: message.toolCallId,
      name: message.toolName,
      args: message.arguments,
    },
    thoughtSignature: message.thoughtSignature,
  };
}

function functionResponseContent(message: Extract<Message, { role: "tool" }>) {
  return {
    role: "user",
    parts: [
      {
        functionResponse: {
          name: message.toolName,
          response: { result: message.content },
        },
      },
    ],
  };
}

/**
 * Renders the conversation into Gemini's `contents`, restoring batched calls.
 *
 * A model that requests several tools at once returns them as parts of a single
 * turn, and signs only the first part. The loop stores each call as its own
 * message and interleaves the results, so replaying that list directly sends
 * one turn per call — and every part after the first then has no signature.
 * Gemini rejects exactly that:
 *
 *   Function call is missing a thought_signature in functionCall parts.
 *
 * Probing the API with the three candidate shapes settled it: separate turns
 * are refused, while one turn carrying every call of the batch is accepted,
 * with or without the results merged. So a batch is emitted as it arrived — one
 * model turn, signature on the part that carries it — followed by its results.
 *
 * Calls without a batchId keep the old one-turn-each shape. They come from a
 * response that requested a single tool, where the question does not arise.
 */
export function buildContents(messages: Message[]) {
  const contents: unknown[] = [];
  const emitted = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    if (emitted.has(i)) continue;
    const message = messages[i]!;

    switch (message.role) {
      case "user":
        contents.push({ role: "user", parts: [{ text: message.content }] });
        break;

      case "assistant":
        contents.push({ role: "model", parts: [{ text: message.content }] });
        break;

      case "tool":
        // Reached only when a result has no matching call in this window; its
        // batch would otherwise have emitted it already.
        contents.push(functionResponseContent(message));
        break;

      case "assistant_tool_call": {
        const batch = [i];
        if (message.batchId) {
          for (let j = i + 1; j < messages.length; j++) {
            const other = messages[j]!;
            if (
              other.role === "assistant_tool_call" &&
              other.batchId === message.batchId
            ) {
              batch.push(j);
            }
          }
        }

        const calls = batch.map((index) => messages[index] as ToolCallMessage);
        for (const index of batch) emitted.add(index);

        contents.push({ role: "model", parts: calls.map(functionCallPart) });

        // The batch's results follow it, in the order the calls were made.
        const ids = new Set(calls.map((call) => call.toolCallId));
        for (let j = i + 1; j < messages.length; j++) {
          const other = messages[j]!;
          if (emitted.has(j)) continue;
          if (other.role !== "tool" || !ids.has(other.toolCallId)) continue;
          emitted.add(j);
          contents.push(functionResponseContent(other));
        }
        break;
      }
    }

    emitted.add(i);
  }

  return contents as Parameters<
    GoogleGenAI["models"]["generateContentStream"]
  >[0]["contents"];
}

function toolParameterType(type: JsonSchemaType) {
  switch (type) {
    case "number":
      return Type.NUMBER;
    case "boolean":
      return Type.BOOLEAN;
    case "array":
      return Type.ARRAY;
    case "object":
      return Type.OBJECT;
    default:
      return Type.STRING;
  }
}

/**
 * Rewrites neutral JSON Schema into the shape the SDK wants.
 *
 * Only the type names differ — Gemini takes an enum where JSON Schema takes a
 * string — so this walks the tree swapping those and leaves everything else,
 * including `enum` values and nested object properties, as it found it.
 */
function geminiSchema(schema: JsonSchema): Record<string, unknown> {
  return {
    type: toolParameterType(schema.type),
    ...(schema.description ? { description: schema.description } : {}),
    ...(schema.enum ? { enum: schema.enum } : {}),
    ...(schema.items ? { items: geminiSchema(schema.items) } : {}),
    ...(schema.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(schema.properties).map(([name, property]) => [
              name,
              geminiSchema(property),
            ]),
          ),
        }
      : {}),
    ...(schema.required?.length ? { required: schema.required } : {}),
  };
}

export function createProviderClient(
  provider: string,
  apiKey: string,
  model?: string,
): ProviderClient {
  // A config written before a provider existed can pair it with another
  // provider's model — providers.json stores the two independently. Sending a
  // Gemini id to Anthropic is a 404 on the first turn, so a known mismatch
  // resolves to the provider's own default.
  //
  // Only a *known* mismatch. A model absent from the catalog is passed through
  // untouched: the catalog is a convenience list, not an allowlist, and a
  // caller naming a model released after this build should reach the provider
  // and get the provider's own answer.
  const mismatched =
    model !== undefined && findModel(model) !== undefined && !modelBelongsToProvider(model, provider);
  const runnable = mismatched ? undefined : model;

  switch (provider) {
    case "google":
    case "gemini":
      return geminiClient(apiKey, runnable ?? defaultModelForProvider("google"));

    case "anthropic":
      return anthropicClient(apiKey, runnable ?? defaultModelForProvider("anthropic"));

    default:
      // Providers listed as disabled in the registry are refused at login and
      // provider-selection time, so reaching here means a config written by an
      // older version (or by hand).
      throw new Error(unsupportedProviderMessage(provider));
  }
}
