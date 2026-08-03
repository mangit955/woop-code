import type Anthropic from "@anthropic-ai/sdk";

/**
 * A stand-in for the Anthropic SDK's `messages.stream`.
 *
 * The client is tested against the wire shapes rather than a mock of itself:
 * these helpers build the same `content_block_start` / `content_block_delta` /
 * `content_block_stop` sequence the API sends, so a test asserts on what the
 * client does with a real event stream. Only the network is faked.
 *
 * `MessageStream` is an `AsyncIterable` with a `finalMessage()` that resolves
 * once the events are drained, which is the entire surface the client uses.
 */
export interface FakeResponse {
  events: Anthropic.MessageStreamEvent[];
  /** Usage on the accumulated message, as `finalMessage()` would report it. */
  usage?: Partial<Anthropic.Usage>;
  /** Fails before any event is produced — the retryable case. */
  throwBeforeStream?: unknown;
  /** Fails partway through, after the caller has already seen output. */
  throwAfterEvents?: unknown;
}

export interface FakeAnthropic {
  /** Cast to the SDK's type at the call site; only `messages.stream` is real. */
  api: { messages: { stream: (params: any, options?: any) => unknown } };
  /** Every request body the client sent, in order. */
  requests: any[];
  /** Every request option object, so a test can inspect the abort signal. */
  options: any[];
}

export function fakeAnthropic(
  respond: (attempt: number) => FakeResponse,
): FakeAnthropic {
  const requests: any[] = [];
  const options: any[] = [];

  return {
    requests,
    options,
    api: {
      messages: {
        stream(params: any, requestOptions?: any) {
          requests.push(params);
          options.push(requestOptions);

          const response = respond(requests.length);
          if (response.throwBeforeStream) throw response.throwBeforeStream;

          const usage = {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            ...response.usage,
          } as Anthropic.Usage;

          return {
            async *[Symbol.asyncIterator]() {
              for (const event of response.events) yield event;
              if (response.throwAfterEvents) throw response.throwAfterEvents;
            },
            async finalMessage() {
              return { usage } as Anthropic.Message;
            },
          };
        },
      },
    },
  };
}

/** Text arriving as one block, in as many deltas as given. */
export function textBlock(index: number, ...chunks: string[]): Anthropic.MessageStreamEvent[] {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "", citations: null },
    } as Anthropic.MessageStreamEvent,
    ...chunks.map(
      (text) =>
        ({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text },
        }) as Anthropic.MessageStreamEvent,
    ),
    { type: "content_block_stop", index } as Anthropic.MessageStreamEvent,
  ];
}

/**
 * A tool call, with its arguments split across `fragments`.
 *
 * The API streams tool input as partial JSON that is only parseable once the
 * block closes, and the split points are arbitrary — mid-key and mid-value are
 * both normal — so tests pass the fragments explicitly rather than a finished
 * object.
 */
export function toolBlock(
  index: number,
  id: string,
  name: string,
  ...fragments: string[]
): Anthropic.MessageStreamEvent[] {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    } as Anthropic.MessageStreamEvent,
    ...fragments.map(
      (partial_json) =>
        ({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json },
        }) as Anthropic.MessageStreamEvent,
    ),
    { type: "content_block_stop", index } as Anthropic.MessageStreamEvent,
  ];
}

/**
 * A thinking block, as it arrives with `display: "omitted"`: no thinking text,
 * a single signature delta, then the close.
 */
export function thinkingBlock(
  index: number,
  signature: string,
  thinking = "",
): Anthropic.MessageStreamEvent[] {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    } as Anthropic.MessageStreamEvent,
    ...(thinking
      ? [
          {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking },
          } as Anthropic.MessageStreamEvent,
        ]
      : []),
    {
      type: "content_block_delta",
      index,
      delta: { type: "signature_delta", signature },
    } as Anthropic.MessageStreamEvent,
    { type: "content_block_stop", index } as Anthropic.MessageStreamEvent,
  ];
}

/** The events that bracket every real response, plus the ping that can appear anywhere. */
export const ping = { type: "ping" } as unknown as Anthropic.MessageStreamEvent;

export function messageStart(): Anthropic.MessageStreamEvent {
  return {
    type: "message_start",
    message: { type: "message", role: "assistant", content: [] },
  } as unknown as Anthropic.MessageStreamEvent;
}

export function messageStop(): Anthropic.MessageStreamEvent[] {
  return [
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    } as unknown as Anthropic.MessageStreamEvent,
    { type: "message_stop" } as unknown as Anthropic.MessageStreamEvent,
  ];
}
