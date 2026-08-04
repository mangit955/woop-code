import type OpenAI from "openai";

type StreamEvent = OpenAI.Responses.ResponseStreamEvent;

/**
 * A stand-in for the OpenAI SDK's `responses.stream`.
 *
 * The client is tested against the wire shapes rather than a mock of itself:
 * these helpers build the same `response.output_item.added` / `.delta` /
 * `response.output_item.done` sequence the API sends, so a test asserts on what
 * the client does with a real event stream. Only the network is faked.
 *
 * `ResponseStream` is an `AsyncIterable` with a `finalResponse()` that resolves
 * once the events are drained, which is the entire surface the client uses.
 */
export interface FakeResponse {
  events: StreamEvent[];
  /** Usage on the final response, as `finalResponse()` would report it. */
  usage?: Partial<OpenAI.Responses.ResponseUsage>;
  /** Fails before any event is produced — the retryable case. */
  throwBeforeStream?: unknown;
  /** Fails partway through, after the caller has already seen output. */
  throwAfterEvents?: unknown;
  /** Omits usage entirely, for the "provider reported nothing" path. */
  withoutUsage?: boolean;
}

export interface FakeOpenAI {
  /** Cast to the SDK's type at the call site; only `responses.stream` is real. */
  api: { responses: { stream: (params: any, options?: any) => unknown } };
  /** Every request body the client sent, in order. */
  requests: any[];
  /** Every request option object, so a test can inspect the abort signal. */
  options: any[];
}

export function fakeOpenAI(respond: (attempt: number) => FakeResponse): FakeOpenAI {
  const requests: any[] = [];
  const options: any[] = [];

  return {
    requests,
    options,
    api: {
      responses: {
        stream(params: any, requestOptions?: any) {
          requests.push(params);
          options.push(requestOptions);

          const response = respond(requests.length);
          if (response.throwBeforeStream) throw response.throwBeforeStream;

          const usage = {
            input_tokens: 0,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 0,
            ...response.usage,
          } as OpenAI.Responses.ResponseUsage;

          return {
            async *[Symbol.asyncIterator]() {
              for (const event of response.events) yield event;
              if (response.throwAfterEvents) throw response.throwAfterEvents;
            },
            async finalResponse() {
              return (
                response.withoutUsage ? {} : { usage }
              ) as OpenAI.Responses.Response;
            },
          };
        },
      },
    },
  };
}

/**
 * Text arriving on one output item, in as many deltas as given.
 *
 * `item_id` and `output_index` are carried on every event the API sends, and
 * the client keys nothing on them for text — but they are included so the
 * fixtures stay the shape a real stream has.
 */
export function textItem(index: number, ...chunks: string[]): StreamEvent[] {
  const item_id = `msg_${index}`;

  return [
    {
      type: "response.output_item.added",
      output_index: index,
      item: { id: item_id, type: "message", role: "assistant", status: "in_progress", content: [] },
    } as unknown as StreamEvent,
    ...chunks.map(
      (delta) =>
        ({
          type: "response.output_text.delta",
          item_id,
          output_index: index,
          content_index: 0,
          delta,
        }) as unknown as StreamEvent,
    ),
    {
      type: "response.output_item.done",
      output_index: index,
      item: {
        id: item_id,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: chunks.join(""), annotations: [] }],
      },
    } as unknown as StreamEvent,
  ];
}

/**
 * A function call, with its arguments streamed as `fragments` and delivered
 * whole on the closing item.
 *
 * That duplication is the API's, not the fixture's: the deltas carry the JSON
 * in arbitrary pieces and the `.done` item repeats it complete. The client
 * reads the complete one, and a test that wants to prove it can pass fragments
 * that do not agree with `args`.
 */
export function functionCallItem(
  index: number,
  callId: string,
  name: string,
  args: string,
  ...fragments: string[]
): StreamEvent[] {
  const item_id = `fc_${index}`;

  return [
    {
      type: "response.output_item.added",
      output_index: index,
      item: {
        id: item_id,
        type: "function_call",
        call_id: callId,
        name,
        arguments: "",
        status: "in_progress",
      },
    } as unknown as StreamEvent,
    ...(fragments.length === 0 ? [args] : fragments).map(
      (delta) =>
        ({
          type: "response.function_call_arguments.delta",
          item_id,
          output_index: index,
          delta,
        }) as unknown as StreamEvent,
    ),
    {
      type: "response.output_item.done",
      output_index: index,
      item: {
        id: item_id,
        type: "function_call",
        call_id: callId,
        name,
        arguments: args,
        status: "completed",
      },
    } as unknown as StreamEvent,
  ];
}

/**
 * A reasoning item.
 *
 * `encrypted_content` is populated only on the `.done` event, which is the
 * whole point of the pair: the `.added` the API really sends carries an empty
 * item, so a client that captured there would replay nothing.
 */
export function reasoningItem(index: number, encrypted: string): StreamEvent[] {
  const item_id = `rs_${index}`;

  return [
    {
      type: "response.output_item.added",
      output_index: index,
      item: { id: item_id, type: "reasoning", summary: [] },
    } as unknown as StreamEvent,
    {
      type: "response.output_item.done",
      output_index: index,
      item: {
        id: item_id,
        type: "reasoning",
        summary: [],
        encrypted_content: encrypted,
        status: "completed",
      },
    } as unknown as StreamEvent,
  ];
}

/** The events that bracket every real response. */
export function responseCreated(): StreamEvent {
  return {
    type: "response.created",
    response: { id: "resp_1", object: "response", output: [] },
  } as unknown as StreamEvent;
}

export function responseCompleted(): StreamEvent {
  return {
    type: "response.completed",
    response: { id: "resp_1", object: "response", output: [] },
  } as unknown as StreamEvent;
}
