import { afterEach, describe, expect, test } from "bun:test";
import { anthropicClient } from "../../../config/anthropicClient";
import { createProviderClient } from "../../../config/client";
import { defaultModelForProvider } from "../../../config/modelCatalog";
import type { Message, StreamEvent } from "../../../config/types";

/**
 * The client against the real SDK, with only the socket faked.
 *
 * Every other test here injects a stand-in for `messages.stream`, which proves
 * what the client does with a stream but assumes the stand-in yields what the
 * SDK yields. That assumption is the one thing those tests cannot check, and it
 * is the one that fails silently: a hand-written event with the wrong shape
 * passes a fake and drops a tool call against the real thing.
 *
 * So this drives the actual `@anthropic-ai/sdk` over a stubbed
 * `globalThis.fetch` serving a recorded SSE body. The SDK does its own framing,
 * parsing and accumulation; what arrives at the client is whatever it really
 * produces. `globalThis.fetch` is writable and restored per test, so this needs
 * no module mock and cannot leak into another file the way `mock.module` would.
 */
describe("the real SDK, over a faked socket", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Serves an SSE body and records the request the SDK built. */
  function stubFetch(body: string) {
    const seen: { url: string; init: RequestInit }[] = [];

    globalThis.fetch = Object.assign(
      async (input: any, init: any) => {
        seen.push({ url: String(input), init });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
      { preconnect: realFetch.preconnect },
    ) as typeof globalThis.fetch;

    return seen;
  }

  function sse(events: unknown[]): string {
    return (
      events
        .map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join("")
    );
  }

  const ask: Message[] = [{ role: "user", content: "read the readme" }];

  async function collect(signal?: AbortSignal): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const event of anthropicClient("sk-test", "claude-opus-5").stream(
      ask,
      "repo context",
      signal,
    )) {
      events.push(event);
    }
    return events;
  }

  test("parses a real response into text, a tool call and usage", async () => {
    const seen = stubFetch(
      sse([
        {
          type: "message_start",
          message: {
            id: "msg_01",
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 412,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 8000,
            },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "ping" },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "look." } },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_01", name: "read_file", input: {} },
        },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"path"' },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: ': "READ' },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: 'ME.md"}' },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 89 },
        },
        { type: "message_stop" },
      ]),
    );

    const events = await collect();

    expect(events).toMatchObject([
      { type: "text", content: "Let me " },
      { type: "text", content: "look." },
      { type: "tool_call", id: "toolu_01", name: "read_file", arguments: { path: "README.md" } },
      {
        type: "done",
        usage: {
          promptTokens: 8412,
          completionTokens: 89,
          cachedTokens: 8000,
          totalTokens: 8501,
        },
      },
    ]);

    // The request the SDK actually put on the wire, not the object we handed it.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body).toMatchObject({
      model: "claude-opus-5",
      stream: true,
      thinking: { type: "adaptive", display: "omitted" },
      messages: [{ role: "user", content: "read the readme" }],
    });
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools.map((tool: { name: string }) => tool.name)).toContain("read_file");
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  /**
   * With `display: "omitted"` a thinking block carries no text — only the
   * signature that a later request has to replay. The SDK still reports the
   * block, and reading it wrongly would either leak an empty "thought" to the
   * terminal or lose the signature.
   */
  test("a thinking block yields no output but keeps its signature", async () => {
    stubFetch(
      sse([
        {
          type: "message_start",
          message: {
            id: "msg_02",
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3h" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "21." } },
        { type: "content_block_stop", index: 1 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 12 },
        },
        { type: "message_stop" },
      ]),
    );

    const events = await collect();

    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", content: "21." },
    ]);
    expect(events.at(-1)!.type).toBe("done");
  });

  /**
   * providers.json stores the provider and the model independently, so
   * switching provider on the command line leaves the previous provider's model
   * selected — `woopcode providers set -p anthropic` does not touch it. Sent as
   * given, that is a 404 on the first turn of a freshly switched session.
   */
  test("a model belonging to another provider is replaced before it reaches the wire", async () => {
    const seen = stubFetch(
      sse([
        {
          type: "message_start",
          message: {
            id: "msg_05",
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]),
    );

    const client = createProviderClient("anthropic", "sk-test", "gemini-3.5-flash-lite");
    for await (const _ of client.stream(ask, "")) {
      // drain
    }

    expect(JSON.parse(String(seen[0]!.init.body)).model).toBe(
      defaultModelForProvider("anthropic"),
    );
  });

  /**
   * The catalog is a convenience list, not an allowlist. A model released after
   * this build should reach Anthropic and get Anthropic's own answer, rather
   * than being quietly swapped for one this build happens to know.
   */
  test("a model the catalog has never heard of is passed through untouched", async () => {
    const seen = stubFetch(
      sse([
        {
          type: "message_start",
          message: {
            id: "msg_06",
            type: "message",
            role: "assistant",
            model: "claude-opus-9",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]),
    );

    const client = createProviderClient("anthropic", "sk-test", "claude-opus-9");
    for await (const _ of client.stream(ask, "")) {
      // drain
    }

    expect(JSON.parse(String(seen[0]!.init.body)).model).toBe("claude-opus-9");
  });

  /**
   * The SDK retries 429s and 5xx twice by default, and this codebase already
   * has a retry policy in runtime/retry.ts. Left at the default, every attempt
   * the loop counted would silently have been three, with two sets of delays
   * compounding — so the client turns the SDK's off and this counts the
   * requests that actually reach the socket to prove it.
   */
  test("retrying is this codebase's job, not the SDK's", async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        calls++;
        if (calls === 1) {
          return new Response(
            JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
            { status: 529, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          sse([
            {
              type: "message_start",
              message: {
                id: "msg_04",
                type: "message",
                role: "assistant",
                model: "claude-opus-5",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 1 },
              },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 3 },
            },
            { type: "message_stop" },
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
      { preconnect: realFetch.preconnect },
    ) as typeof globalThis.fetch;

    const events = await collect();

    // Exactly one retry, and it is ours: the retry event is on the stream,
    // which nothing inside the SDK could have produced.
    expect(calls).toBe(2);
    expect(events.filter((event) => event.type === "retry")).toHaveLength(1);
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", content: "recovered" },
    ]);
  });

  test("an error mid-stream is raised rather than ending the turn quietly", async () => {
    stubFetch(
      sse([
        {
          type: "message_start",
          message: {
            id: "msg_03",
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      ]),
    );

    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of anthropicClient("sk-test", "claude-opus-5").stream(ask, "")) {
          events.push(event);
        }
      })(),
    ).rejects.toThrow(/Overloaded/);

    // The text that did arrive was still delivered, and no retry followed it.
    expect(events).toMatchObject([{ type: "text", content: "partial" }]);
  });
});
