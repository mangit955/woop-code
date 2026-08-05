import OpenAI from "openai";
import { toolRegistry } from "../tools";
import { SYSTEM_PROMPT } from "../config/systemPrompt";
import { thinkingBudget } from "./client";
import { defaultModelForProvider } from "./modelCatalog";
import type { Message, ProviderClient, StreamEvent, TokenUsage, Tool } from "../config/types";
import { toolInputSchema } from "../config/toolSchema";
import { imageParts, imageText } from "./images";
import { classifyFailure, delay, maxAttempts } from "../runtime/retry";

/** Only the surface this client uses, so a test can supply a fake. */
type ResponsesApi = Pick<OpenAI, "responses">;

/**
 * How long a single provider request may take. Matches the other two clients:
 * long enough that a response still streaming is treated as progress rather
 * than a stall.
 */
const REQUEST_TIMEOUT_MS = 300_000;

/** A reasoning item, kept exactly as the model produced it. */
type ReasoningItem = OpenAI.Responses.ResponseReasoningItem;

/**
 * The reasoning configuration, translated from `WOOPCODE_THINKING_BUDGET`.
 *
 * The variable was designed against Gemini, where a budget is a token count.
 * OpenAI takes an effort level instead — `none`, `minimal`, `low`, `medium`,
 * `high`, `xhigh`, `max` — and there is no honest conversion from one to the
 * other, so a token count is not faked into a level. Any value other than `off`
 * means "the model decides", expressed by sending no `reasoning` at all and
 * letting the model's own default effort stand. That is the same intent as
 * Gemini's -1 default, which is the value the variable carries when nobody
 * sets it.
 *
 * `off` is `effort: "none"`, the one level that asks for no reasoning. Unlike
 * Gemini — where "disable" could not be expressed as a number and needed the
 * config omitted entirely — here it is a value the API accepts directly.
 */
export function openaiReasoning(
  env: Record<string, string | undefined> = process.env,
): OpenAI.Reasoning | undefined {
  return thinkingBudget(env) === undefined ? { effort: "none" } : undefined;
}

export function openaiClient(
  apiKey: string,
  model = defaultModelForProvider("openai"),
  injected?: ResponsesApi,
): ProviderClient {
  // Built on the first request, not here: constructing a client should cost
  // nothing until it is used. See the same note in client.ts.
  let sdk = injected;
  // maxRetries: 0 because retry policy lives in runtime/retry.ts. Left at the
  // SDK's default of 2, every attempt this client counts would silently be
  // three, and the delays would compound with the ones we schedule.
  const api = () => (sdk ??= new OpenAI({ apiKey, maxRetries: 0 }));

  /**
   * Reasoning items from this turn, keyed by the tool call they accompanied.
   *
   * The Responses API is stateless here by choice — `store: false`, because the
   * conversation is rebuilt from `Message[]` on every turn and compaction
   * rewrites it, so there is no server-side response to continue from. The cost
   * of that is that reasoning is only preserved if it is sent back: an item
   * dropped between two tool calls is not an error, the model simply reasons
   * from less than it had. That is a silent quality loss, which is exactly the
   * failure the Anthropic client documents at the same place.
   *
   * The map lives here rather than on `Message` because the requirement is
   * scoped to a single tool-use turn, and a client is constructed per turn
   * (agentController.run). That keeps the agent loop, the message type and
   * persistence provider-agnostic, which is the point of all three.
   */
  const reasoningByToolCallId = new Map<string, ReasoningItem[]>();

  return {
    async *stream(
      messages: Message[],
      repoContext: string,
      signal?: AbortSignal,
      useTools = true,
      offeredTools: readonly Tool[] = toolRegistry,
    ): AsyncGenerator<StreamEvent> {
      // Not the whole registry: plan mode narrows this, and a client that reads
      // the registry directly silently offers writing tools while planning.
      const tools = offeredTools.map(toolSchema);

      // Read once per turn, for the same reason the loop reads its own budgets
      // once: two requests of one turn should not assemble to different rules.
      const reasoning = openaiReasoning();

      // Retrying is only safe while nothing has been observed. Once a chunk has
      // been yielded the caller has already streamed it to the terminal, so
      // starting again would duplicate output the user watched arrive.
      for (let attempt = 1; ; attempt++) {
        let emittedModelOutput = false;

        const requestController = new AbortController();
        let timedOut = false;
        const abortFromCaller = () => requestController.abort();
        const timeout = setTimeout(() => {
          timedOut = true;
          requestController.abort();
        }, REQUEST_TIMEOUT_MS);

        if (signal) {
          if (signal.aborted) {
            abortFromCaller();
          } else {
            signal.addEventListener("abort", abortFromCaller, { once: true });
          }
        }

        try {
          const response = api().responses.stream(
            {
              model,
              // The system prompt and repository context are byte-identical
              // across every iteration of a turn, and `instructions` leads the
              // prompt, so OpenAI's automatic prefix caching covers it. There
              // is no marker to set — unlike Anthropic, where caching is opted
              // into per block.
              instructions: repoContext
                ? `${SYSTEM_PROMPT}\n\nRepository Context:\n${repoContext}`
                : SYSTEM_PROMPT,
              input: buildOpenAIInput(messages, reasoningByToolCallId),
              ...(useTools ? { tools } : {}),
              // Nothing is kept server-side; see reasoningByToolCallId above.
              store: false,
              ...(reasoning ? { reasoning } : {}),
            },
            { signal: requestController.signal },
          );

          // Reasoning items and tool calls of this response. The reasoning is
          // collected across the whole response and attached to every call it
          // preceded, because the model reasons for the response, not per call.
          const turnReasoning: ReasoningItem[] = [];
          const toolCallIds: string[] = [];

          for await (const event of response) {
            switch (event.type) {
              case "response.output_text.delta": {
                if (event.delta) {
                  emittedModelOutput = true;
                  yield { type: "text", content: event.delta };
                }
                break;
              }

              // Every output item is announced with `.added` and completed with
              // `.done`, and `.done` carries the item whole — a function call's
              // `arguments` in full, so the `function_call_arguments.delta`
              // fragments do not need accumulating.
              //
              // Reasoning in particular *must* be read here and not from
              // `.added`, where `encrypted_content` is not yet populated. An
              // item captured too early looks correct and replays nothing.
              case "response.output_item.done": {
                const item = event.item;

                if (item.type === "reasoning") {
                  turnReasoning.push(item);
                } else if (item.type === "function_call") {
                  emittedModelOutput = true;
                  toolCallIds.push(item.call_id);
                  yield {
                    type: "tool_call",
                    // call_id, not id: `id` identifies the output item, while
                    // `call_id` is what a function_call_output is matched on.
                    id: item.call_id,
                    name: item.name,
                    arguments: parseToolInput(item.arguments),
                  };
                }
                break;
              }

              // response.created, .in_progress, .completed, the argument and
              // reasoning deltas, and anything added later. Usage is read from
              // the final response below rather than from these.
              default:
                break;
            }
          }

          if (turnReasoning.length > 0) {
            for (const id of toolCallIds) reasoningByToolCallId.set(id, turnReasoning);
          }

          yield { type: "done", usage: readUsage(await response.finalResponse()) };
          return;
        } catch (error: any) {
          // The caller cancelled the turn. Not a failure, and never retried.
          if (signal?.aborted) throw error;

          const failure = timedOut
            ? new Error(
                `OpenAI did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds. ` +
                  `Check your network connection and API quota, then try again.`,
              )
            : error;

          if (!emittedModelOutput) {
            const decision = classifyFailure(failure, attempt, maxAttempts());

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

          throw describeFailure(failure);
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abortFromCaller);
        }
      }
    },
  };
}

/**
 * The arguments of one tool call, which arrive as a JSON string.
 *
 * A tool taking no arguments produces an empty string, which is an empty object
 * rather than a parse error. A malformed string is an empty object too: the
 * model sees the tool's own complaint about missing arguments and can correct
 * it, which is the behaviour the loop is built around, whereas throwing would
 * end the turn.
 */
function parseToolInput(json: string): Record<string, unknown> {
  const trimmed = json.trim();
  if (trimmed === "") return {};

  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Token counts, in this codebase's terms rather than OpenAI's.
 *
 * Every field maps straight across, which is worth stating because the
 * Anthropic client next door does not: there `input_tokens` excludes anything
 * cached and the three counts have to be summed. OpenAI's `input_tokens` is
 * already the whole prompt, with the cached portion reported as a breakdown of
 * it — which is the relationship `TokenUsage` documents, so no arithmetic.
 *
 * `thoughtTokens` is reported, unlike Anthropic, which bills reasoning inside
 * `output_tokens` without breaking it out.
 */
function readUsage(response: OpenAI.Responses.Response): TokenUsage | undefined {
  const usage = response.usage;
  if (!usage) return undefined;

  return {
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    cachedTokens: usage.input_tokens_details?.cached_tokens,
    thoughtTokens: usage.output_tokens_details?.reasoning_tokens,
    totalTokens: usage.total_tokens,
  };
}

/** Rewrites the failures a user can act on into instructions they can follow. */
function describeFailure(error: unknown): unknown {
  if (error instanceof OpenAI.AuthenticationError) {
    return new Error(
      `OpenAI rejected the API key.\n\n` +
        `Run "woopcode providers login -p openai -a <api-key>" with a key from ` +
        `https://platform.openai.com/api-keys`,
    );
  }

  if (error instanceof OpenAI.RateLimitError) {
    return new Error(
      `⚠️  Rate limit exceeded for the OpenAI API.\n\n` +
        `You can:\n` +
        `  • Wait and retry your request\n` +
        `  • Switch to a smaller model with /models\n` +
        `  • Check your limits at: https://platform.openai.com/settings/organization/limits`,
    );
  }

  return error;
}

/**
 * A tool's arguments as JSON Schema.
 *
 * The mapping itself lives in `config/toolSchema.ts` — the two branches this
 * file's own note anticipated have now met, so the third copy is folded onto the
 * shared one rather than left to settle in. Only the envelope is OpenAI's.
 */
function toolSchema(tool: Tool): OpenAI.Responses.FunctionTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    // The SDK types `parameters` as an open record, so a closed interface does
    // not satisfy it. Cast at the boundary rather than opening ours up, which
    // would let a typo through everywhere else the schema is used.
    parameters: toolInputSchema(tool) as unknown as Record<string, unknown>,
    // The registry marks optional parameters, and strict mode requires every
    // property be required. Enforcing it would make every optional argument
    // mandatory, so validation stays with the tools, which report to the model.
    strict: false,
  };
}

type ToolCallMessage = Extract<Message, { role: "assistant_tool_call" }>;

/**
 * Renders the conversation into the Responses API's `input`.
 *
 * Simpler than the other two clients, because this input is a flat list of
 * items rather than turns: a tool call and its result are siblings, so nothing
 * has to be grouped into a message. Two things still shape it:
 *
 * 1. A batch — several calls the model made in one response, sharing a batchId —
 *    is emitted together, calls first and then their results, so the order the
 *    model produced them in survives the loop having stored each separately.
 * 2. The reasoning items that accompanied those calls come back ahead of them
 *    (see `reasoningByToolCallId`).
 *
 * Calls without a batchId keep the one-at-a-time shape. They come from a
 * response that requested a single tool, where the question does not arise.
 */
export function buildOpenAIInput(
  messages: Message[],
  reasoningByToolCallId: Map<string, ReasoningItem[]> = new Map(),
): OpenAI.Responses.ResponseInputItem[] {
  const input: OpenAI.Responses.ResponseInputItem[] = [];
  const emitted = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    if (emitted.has(i)) continue;
    const message = messages[i]!;
    emitted.add(i);

    switch (message.role) {
      case "user": {
        const images = imageParts(message.images);
        const text = imageText(message.content, message.images?.length ?? 0, images);
        input.push(
          images.length === 0
            ? { role: "user", content: text }
            : {
                role: "user",
                content: [
                  { type: "input_text", text },
                  // A data URL rather than an uploaded file id: the client is
                  // stateless by choice (`store: false`), so there is nothing
                  // to hang an uploaded file's lifetime on.
                  ...images.map((image) => ({
                    type: "input_image" as const,
                    image_url: `data:${image.mediaType};base64,${image.base64}`,
                    detail: "auto" as const,
                  })),
                ],
              },
        );
        break;
      }

      case "assistant":
        // A turn that streamed nothing but tool calls leaves an empty assistant
        // message behind, which says nothing and costs a token or two.
        if (message.content.trim() !== "") {
          input.push({ role: "assistant", content: message.content });
        }
        break;

      case "tool":
        // A result whose call is not in this window. Its batch would otherwise
        // have emitted it already, and `recentMessages` only ever cuts the
        // history at a user message — which is always before the calls that
        // followed it — so this should not arise.
        //
        // Described in a plain message rather than as a function_call_output,
        // which would name a call this request never makes.
        input.push({
          role: "user",
          content: `Result of an earlier ${message.toolName} call:\n${message.content}`,
        });
        break;

      case "assistant_tool_call": {
        const batch = [i];
        if (message.batchId) {
          for (let j = i + 1; j < messages.length; j++) {
            const other = messages[j]!;
            if (other.role === "assistant_tool_call" && other.batchId === message.batchId) {
              batch.push(j);
            }
          }
        }

        const calls = batch.map((index) => messages[index] as ToolCallMessage);
        for (const index of batch) emitted.add(index);

        input.push(...(reasoningByToolCallId.get(calls[0]!.toolCallId) ?? []));
        input.push(...calls.map(functionCallItem));

        // Every call in the batch is answered. A call whose result is missing —
        // the turn was cancelled between the two — gets a placeholder rather
        // than being dropped, so the model is told the call ended rather than
        // left waiting on it.
        const ids = new Set(calls.map((call) => call.toolCallId));
        const results = new Map<string, OpenAI.Responses.ResponseInputItem>();
        for (let j = i + 1; j < messages.length; j++) {
          const other = messages[j]!;
          if (emitted.has(j)) continue;
          if (other.role !== "tool" || !ids.has(other.toolCallId)) continue;
          emitted.add(j);
          results.set(other.toolCallId, functionCallOutput(other));
        }

        for (const call of calls) {
          input.push(
            results.get(call.toolCallId) ?? {
              type: "function_call_output",
              call_id: call.toolCallId,
              output: "Tool execution did not complete.",
            },
          );
        }
        break;
      }
    }
  }

  return input;
}

function functionCallItem(message: ToolCallMessage): OpenAI.Responses.ResponseInputItem {
  return {
    type: "function_call",
    call_id: message.toolCallId,
    name: message.toolName,
    arguments: JSON.stringify(message.arguments),
  };
}

function functionCallOutput(
  message: Extract<Message, { role: "tool" }>,
): OpenAI.Responses.ResponseInputItem {
  return {
    type: "function_call_output",
    call_id: message.toolCallId,
    // The model needs to be told the tool ran and said nothing, which is
    // different from it not having run.
    output: message.content === "" ? "(no output)" : message.content,
  };
}
