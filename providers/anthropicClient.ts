import Anthropic from "@anthropic-ai/sdk";
import { toolRegistry } from "../tools";
import { SYSTEM_PROMPT } from "../config/systemPrompt";
import { thinkingBudget } from "./client";
import { defaultModelForProvider } from "./modelCatalog";
import type { Message, ProviderClient, StreamEvent, TokenUsage, Tool } from "../config/types";
import { toolInputSchema } from "../config/toolSchema";
import { imageParts, imageText } from "./images";
import { classifyFailure, delay, maxAttempts } from "../runtime/retry";

/** Only the surface this client uses, so a test can supply a fake. */
type MessagesApi = Pick<Anthropic, "messages">;

/**
 * How long a single provider request may take. Matches the Gemini client:
 * long enough that a response still streaming is treated as progress rather
 * than a stall.
 */
const REQUEST_TIMEOUT_MS = 300_000;

/**
 * Output ceiling for one response.
 *
 * Required by the API — unlike Gemini, where it is optional — so it is a
 * decision this client has to make rather than inherit. 64,000 is the largest
 * value every model in `models.json` accepts: Claude Haiku 4.5 caps there,
 * the rest at 128,000. It is deliberately generous because thinking tokens are
 * billed against the same budget as the answer, so a tight ceiling truncates
 * mid-response on exactly the long agentic turns this tool exists for.
 */
const MAX_OUTPUT_TOKENS = 64_000;

/**
 * The reasoning configuration, translated from `WOOPCODE_THINKING_BUDGET`.
 *
 * The variable was designed against Gemini, where a budget is a token count.
 * Anthropic's current models reject `budget_tokens` outright, so the numeric
 * form has no equivalent here and is not faked into one: any value other than
 * `off` means adaptive, where the model decides depth for itself. That is the
 * same intent as Gemini's -1 default, which is the value the variable already
 * carries when nobody sets it.
 *
 * `display: "omitted"` is set explicitly rather than left to the model's
 * default, which differs between model generations. Omitted returns a signature
 * without the reasoning text — which is all this client needs, since the TUI has
 * nowhere to render reasoning and the signature is what a later request must
 * replay. Thinking is billed identically either way; omitting only drops the
 * summary.
 *
 * `disabled` is accepted by every model here because no `effort` is sent, so
 * effort stays at its default of `high`; Claude Opus 5 refuses to disable
 * thinking only above that.
 */
export function anthropicThinking(
  env: Record<string, string | undefined> = process.env,
): Anthropic.ThinkingConfigParam {
  return thinkingBudget(env) === undefined
    ? { type: "disabled" }
    : { type: "adaptive", display: "omitted" };
}

/** A thinking or redacted-thinking block, kept exactly as the model produced it. */
type ReasoningBlock = Anthropic.ThinkingBlockParam | Anthropic.RedactedThinkingBlockParam;

export function anthropicClient(
  apiKey: string,
  model = defaultModelForProvider("anthropic"),
  injected?: MessagesApi,
): ProviderClient {
  // Built on the first request, not here: constructing a client should cost
  // nothing until it is used. See the same note in client.ts.
  let sdk = injected;
  // maxRetries: 0 because retry policy lives in runtime/retry.ts. Left at the
  // SDK's default of 2, every attempt this client counts would silently be
  // three, and the delays would compound with the ones we schedule.
  const api = () => (sdk ??= new Anthropic({ apiKey, maxRetries: 0 }));

  /**
   * Reasoning blocks from this turn, keyed by the tool call they accompanied.
   *
   * When Claude calls a tool it pauses mid-response; returning the result
   * resumes that same response, so the reasoning that led to the call has to
   * still be there. The API is explicit that thinking blocks must be passed
   * back "complete and unmodified", and that modified ones are rejected with a
   * 400. Omitting them is not an error in adaptive mode — the API quietly
   * disables thinking for that request instead, which is a silent quality loss
   * with nothing in the response to notice it by.
   *
   * The map lives here rather than on `Message` because the requirement is
   * scoped to a single tool-use turn, and a client is constructed per turn
   * (agentController.run). That keeps the agent loop, the message type and
   * persistence provider-agnostic, which is the point of all three.
   */
  const reasoningByToolCallId = new Map<string, ReasoningBlock[]>();

  return {
    async *stream(
      messages: Message[],
      repoContext: string,
      signal?: AbortSignal,
      useTools = true,
      offeredTools: readonly Tool[] = toolRegistry,
    ): AsyncGenerator<StreamEvent> {
      const tools = offeredTools.map(toolSchema);

      // Read once per turn, for the same reason the loop reads its own budgets
      // once: two requests of one turn should not assemble to different rules.
      // It is also rendered into the prompt, so changing it mid-turn would
      // start the cache over.
      const thinking = anthropicThinking();

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
          const response = api().messages.stream(
            {
              model,
              max_tokens: MAX_OUTPUT_TOKENS,
              // One block, marked for caching. The system prompt and repository
              // context are byte-identical across every iteration of a turn, so
              // this is read from cache from the second iteration onward; it
              // adds nothing to the prefix, it only marks what is already there.
              system: [
                {
                  type: "text",
                  text: repoContext
                    ? `${SYSTEM_PROMPT}\n\nRepository Context:\n${repoContext}`
                    : SYSTEM_PROMPT,
                  cache_control: { type: "ephemeral" },
                },
              ],
              messages: buildAnthropicMessages(messages, reasoningByToolCallId),
              ...(useTools ? { tools } : {}),
              thinking,
            },
            { signal: requestController.signal },
          );

          // Reasoning blocks and tool calls of this response. The reasoning is
          // collected across the whole response and attached to every call it
          // preceded, because the model signs the response, not the call.
          const reasoning: ReasoningBlock[] = [];
          const toolCallIds: string[] = [];
          // Content blocks are streamed by index and interleaved, so a partial
          // block has to be held until its content_block_stop.
          const open = new Map<number, OpenBlock>();

          for await (const event of response) {
            switch (event.type) {
              case "content_block_start": {
                const block = event.content_block;
                if (block.type === "tool_use") {
                  open.set(event.index, {
                    kind: "tool",
                    id: block.id,
                    name: block.name,
                    json: "",
                  });
                } else if (block.type === "thinking") {
                  open.set(event.index, { kind: "thinking", thinking: "", signature: "" });
                } else if (block.type === "redacted_thinking") {
                  open.set(event.index, { kind: "redacted", data: block.data });
                }
                break;
              }

              case "content_block_delta": {
                const pending = open.get(event.index);
                const delta = event.delta;

                if (delta.type === "text_delta") {
                  if (delta.text) {
                    emittedModelOutput = true;
                    yield { type: "text", content: delta.text };
                  }
                } else if (delta.type === "input_json_delta" && pending?.kind === "tool") {
                  pending.json += delta.partial_json;
                } else if (delta.type === "thinking_delta" && pending?.kind === "thinking") {
                  pending.thinking += delta.thinking;
                } else if (delta.type === "signature_delta" && pending?.kind === "thinking") {
                  pending.signature = delta.signature;
                }
                break;
              }

              case "content_block_stop": {
                const pending = open.get(event.index);
                open.delete(event.index);
                if (!pending) break;

                if (pending.kind === "thinking") {
                  reasoning.push({
                    type: "thinking",
                    thinking: pending.thinking,
                    signature: pending.signature,
                  });
                } else if (pending.kind === "redacted") {
                  reasoning.push({ type: "redacted_thinking", data: pending.data });
                } else {
                  emittedModelOutput = true;
                  toolCallIds.push(pending.id);
                  yield {
                    type: "tool_call",
                    id: pending.id,
                    name: pending.name,
                    arguments: parseToolInput(pending.json),
                  };
                }
                break;
              }

              // message_start, message_delta, message_stop, ping, and anything
              // added later. Usage is read from the accumulated message below
              // rather than from these, because message_delta reports
              // cumulative counts and which fields it carries varies.
              default:
                break;
            }
          }

          if (reasoning.length > 0) {
            for (const id of toolCallIds) reasoningByToolCallId.set(id, reasoning);
          }

          yield { type: "done", usage: readUsage(await response.finalMessage()) };
          return;
        } catch (error: any) {
          // The caller cancelled the turn. Not a failure, and never retried.
          if (signal?.aborted) throw error;

          const failure = timedOut
            ? new Error(
                `Claude did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds. ` +
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

type OpenBlock =
  | { kind: "tool"; id: string; name: string; json: string }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted"; data: string };

/**
 * The accumulated arguments of one tool call.
 *
 * Arguments arrive as fragments of a JSON string and are only valid once the
 * block closes; a tool taking no arguments produces no fragments at all, or a
 * single empty one, which is why an empty buffer is an empty object rather than
 * a parse error. A malformed buffer yields an empty object too: the model sees
 * the tool's own complaint about missing arguments and can correct it, which is
 * the behaviour the loop is built around, whereas throwing would end the turn.
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
 * Token counts, in this codebase's terms rather than Anthropic's.
 *
 * `input_tokens` excludes anything served from or written to the cache, so
 * reading it as the prompt size under-reports every cached turn — and the whole
 * point of the cache marker is that most of the prompt stops being counted
 * there. `promptTokens` is the sum of all three, which keeps `cachedTokens` a
 * subset of it, the same relationship the Gemini client reports.
 *
 * `thoughtTokens` is left unset: Anthropic bills thinking inside
 * `output_tokens` and does not break it out, and TokenUsage's contract is that
 * a count it does not have is missing rather than guessed.
 */
function readUsage(message: Anthropic.Message): TokenUsage | undefined {
  const usage = message.usage;
  if (!usage) return undefined;

  const promptTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);

  return {
    promptTokens,
    completionTokens: usage.output_tokens,
    cachedTokens: usage.cache_read_input_tokens ?? undefined,
    totalTokens: promptTokens + (usage.output_tokens ?? 0),
  };
}

/** Rewrites the failures a user can act on into instructions they can follow. */
function describeFailure(error: unknown): unknown {
  if (error instanceof Anthropic.AuthenticationError) {
    return new Error(
      `Anthropic rejected the API key.\n\n` +
        `Run "woopcode providers login -p anthropic -a <api-key>" with a key from ` +
        `https://console.anthropic.com/settings/keys`,
    );
  }

  if (error instanceof Anthropic.RateLimitError) {
    return new Error(
      `⚠️  Rate limit exceeded for the Anthropic API.\n\n` +
        `You can:\n` +
        `  • Wait and retry your request\n` +
        `  • Switch to a smaller model with /models\n` +
        `  • Check your limits at: https://console.anthropic.com/settings/limits`,
    );
  }

  return error;
}

/**
 * Anthropic takes JSON Schema directly, so the shared builder is the schema —
 * there is nothing to translate, unlike Gemini's enum of type names.
 */
function toolSchema(tool: Tool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    // The SDK types `input_schema` as an open record, so a closed interface does
    // not satisfy it. Cast at the boundary rather than opening ours up, which
    // would let a typo through everywhere else the schema is used.
    input_schema: toolInputSchema(tool) as Anthropic.Tool.InputSchema,
  };
}

type ToolCallMessage = Extract<Message, { role: "assistant_tool_call" }>;

/**
 * Renders the conversation into Anthropic's `messages`.
 *
 * Two rules shape this, both stricter than Gemini's:
 *
 * 1. Every `tool_use` block in an assistant turn must be answered by a
 *    `tool_result` in the single user message that follows it. The loop stores
 *    each call and each result as its own message, so a batch — several calls
 *    the model made in one response, sharing a batchId — has to be reassembled
 *    into one assistant turn and one user turn.
 * 2. The reasoning blocks that accompanied those calls must come back with
 *    them, unmodified and ahead of the calls (see `reasoningByToolCallId`).
 *
 * Calls without a batchId keep the one-turn-each shape. They come from a
 * response that requested a single tool, where the question does not arise.
 */
export function buildAnthropicMessages(
  messages: Message[],
  reasoningByToolCallId: Map<string, ReasoningBlock[]> = new Map(),
): Anthropic.MessageParam[] {
  const rendered: Anthropic.MessageParam[] = [];
  const emitted = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    if (emitted.has(i)) continue;
    const message = messages[i]!;
    emitted.add(i);

    switch (message.role) {
      case "user": {
        const images = imageParts(message.images);
        const text = imageText(message.content, message.images?.length ?? 0, images);
        rendered.push(
          images.length === 0
            ? { role: "user", content: text }
            : {
                role: "user",
                content: [
                  { type: "text", text },
                  ...images.map(
                    (image) =>
                      ({
                        type: "image",
                        source: {
                          type: "base64",
                          media_type: image.mediaType as "image/png",
                          data: image.base64,
                        },
                      }) as const,
                  ),
                ],
              },
        );
        break;
      }

      case "assistant":
        // A turn that streamed nothing but tool calls leaves an empty assistant
        // message behind; the API rejects empty content.
        if (message.content.trim() !== "") {
          rendered.push({ role: "assistant", content: message.content });
        }
        break;

      case "tool":
        // A result whose call is not in this window. Its batch would otherwise
        // have emitted it already, and `recentMessages` only ever cuts the
        // history at a user message — which is always before the calls that
        // followed it — so this should not arise.
        //
        // It is rendered as plain text rather than a `tool_result` block
        // because the two failure modes are not comparable. A tool_result whose
        // tool_use is absent is rejected outright, so a window that ever did
        // produce one would end the turn with a 400. Describing the result in a
        // user message says the same thing in a shape that is always valid.
        rendered.push({
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

        const reasoning = reasoningByToolCallId.get(calls[0]!.toolCallId) ?? [];
        rendered.push({
          role: "assistant",
          content: [...reasoning, ...calls.map(toolUseBlock)],
        });

        // Every call in the batch must be answered, in one message. A call
        // whose result is missing — the turn was cancelled between the two —
        // gets a placeholder rather than being dropped, because an unanswered
        // tool_use is rejected outright.
        const ids = new Set(calls.map((call) => call.toolCallId));
        const results = new Map<string, Anthropic.ToolResultBlockParam>();
        for (let j = i + 1; j < messages.length; j++) {
          const other = messages[j]!;
          if (emitted.has(j)) continue;
          if (other.role !== "tool" || !ids.has(other.toolCallId)) continue;
          emitted.add(j);
          results.set(other.toolCallId, toolResultBlock(other));
        }

        rendered.push({
          role: "user",
          content: calls.map(
            (call) =>
              results.get(call.toolCallId) ?? {
                type: "tool_result" as const,
                tool_use_id: call.toolCallId,
                content: "Tool execution did not complete.",
                is_error: true,
              },
          ),
        });
        break;
      }
    }
  }

  return rendered;
}

function toolUseBlock(message: ToolCallMessage): Anthropic.ToolUseBlockParam {
  return {
    type: "tool_use",
    id: message.toolCallId,
    name: message.toolName,
    input: message.arguments,
  };
}

function toolResultBlock(
  message: Extract<Message, { role: "tool" }>,
): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: message.toolCallId,
    // An empty result is rejected; the model needs to be told the tool ran and
    // said nothing, which is different from it not having run.
    content: message.content === "" ? "(no output)" : message.content,
  };
}
