import { afterEach, describe, expect, test } from "bun:test";
import { buildOpenAIInput, openaiClient, openaiReasoning } from "../../../config/openaiClient";
import { createProviderClient } from "../../../config/client";
import { defaultModelForProvider } from "../../../config/modelCatalog";
import { maxAttempts } from "../../../runtime/retry";
import type { Message, StreamEvent } from "../../../config/types";
import {
  fakeOpenAI,
  functionCallItem,
  reasoningItem,
  responseCompleted,
  responseCreated,
  textItem,
} from "../shared/openaiStream";

const ask: Message[] = [{ role: "user", content: "Inspect the project" }];

async function collect(
  client: ReturnType<typeof openaiClient>,
  messages: Message[] = ask,
  signal?: AbortSignal,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of client.stream(messages, "repo", signal)) {
    events.push(event);
  }
  return events;
}

describe("reasoning configuration", () => {
  test("off is the one value that asks for no reasoning", () => {
    expect(openaiReasoning({ WOOPCODE_THINKING_BUDGET: "off" })).toEqual({ effort: "none" });
  });

  /**
   * The variable was designed for Gemini, where it is a token count. OpenAI
   * takes an effort level, and there is no honest conversion between the two —
   * inventing one would report a budget that was never applied. Every non-`off`
   * value means the same thing here: let the model decide, by sending no
   * reasoning configuration at all.
   */
  test("a token count is not faked into an effort level", () => {
    expect(openaiReasoning({})).toBeUndefined();
    expect(openaiReasoning({ WOOPCODE_THINKING_BUDGET: "2048" })).toBeUndefined();
    expect(openaiReasoning({ WOOPCODE_THINKING_BUDGET: "-1" })).toBeUndefined();
  });
});

describe("OpenAI provider adapter", () => {
  test("serializes tool schemas and sends the prompt as instructions", async () => {
    const fake = fakeOpenAI(() => ({ events: [...textItem(0, "ok")] }));

    await collect(openaiClient("k", "gpt-5.5", fake.api as any));

    const request = fake.requests[0];
    expect(request.model).toBe("gpt-5.5");
    expect(request.instructions).toContain("Repository Context:");

    const askUser = request.tools.find((tool: { name: string }) => tool.name === "ask_user");
    expect(askUser).toMatchObject({
      type: "function",
      parameters: {
        type: "object",
        properties: { questions: { type: "array", items: { type: "string" } } },
      },
    });
    expect(askUser.parameters.required).toContain("questions");
  });

  /**
   * Nothing is kept server-side: the conversation is rebuilt from `Message[]`
   * every turn and compaction rewrites it, so there is no stored response to
   * continue from. Storing anyway would leave the reasoning replay below
   * looking redundant while quietly depending on state this client never uses.
   */
  test("requests are stateless", async () => {
    const fake = fakeOpenAI(() => ({ events: [...textItem(0, "ok")] }));

    await collect(openaiClient("k", "m", fake.api as any));

    expect(fake.requests[0].store).toBe(false);
  });

  test("reasoning is omitted unless the budget says off", async () => {
    const fake = fakeOpenAI(() => ({ events: [...textItem(0, "ok")] }));

    await collect(openaiClient("k", "m", fake.api as any));

    expect(fake.requests[0]).not.toHaveProperty("reasoning");
  });

  test("no tools are sent when the caller asks for none", async () => {
    const fake = fakeOpenAI(() => ({ events: [...textItem(0, "ok")] }));

    for await (const _ of openaiClient("k", "m", fake.api as any).stream(
      ask,
      "",
      undefined,
      false,
    )) {
      // drain
    }

    expect(fake.requests[0].tools).toBeUndefined();
  });

  test("streams text deltas in order", async () => {
    const fake = fakeOpenAI(() => ({
      events: [responseCreated(), ...textItem(0, "Let me ", "look."), responseCompleted()],
    }));

    const events = await collect(openaiClient("k", "m", fake.api as any));

    expect(events).toMatchObject([
      { type: "text", content: "Let me " },
      { type: "text", content: "look." },
      { type: "done" },
    ]);
  });

  /**
   * The closing item carries the arguments whole, so the client reads them
   * there rather than accumulating the deltas. The fragments here deliberately
   * disagree with the finished value: a client that reassembled them would
   * produce `truncated.md` and fail.
   */
  test("takes tool arguments from the completed item, not the deltas", async () => {
    const fake = fakeOpenAI(() => ({
      events: [
        ...textItem(0, "Let me look."),
        ...functionCallItem(
          1,
          "call_1",
          "read_file",
          '{"path": "README.md"}',
          '{"path"',
          ': "truncated.md"}',
        ),
      ],
    }));

    const events = await collect(openaiClient("k", "m", fake.api as any));

    expect(events).toMatchObject([
      { type: "text", content: "Let me look." },
      { type: "tool_call", id: "call_1", name: "read_file", arguments: { path: "README.md" } },
      { type: "done" },
    ]);
  });

  /**
   * A function call carries two identifiers. `id` names the output item;
   * `call_id` is what a `function_call_output` is matched on, so it is the one
   * the loop has to carry. Yielding `id` produces calls that can never be
   * answered.
   */
  test("a tool call is identified by call_id, not the item id", async () => {
    const fake = fakeOpenAI(() => ({
      events: [...functionCallItem(0, "call_abc", "read_file", '{"path": "a.ts"}')],
    }));

    const events = await collect(openaiClient("k", "m", fake.api as any));

    expect(events[0]).toMatchObject({ type: "tool_call", id: "call_abc" });
    expect(events[0]).not.toMatchObject({ id: "fc_0" });
  });

  test("keeps every call of a parallel batch, in order", async () => {
    const fake = fakeOpenAI(() => ({
      events: [
        ...functionCallItem(0, "call_1", "read_file", '{"path": "a.ts"}'),
        ...functionCallItem(1, "call_2", "read_file", '{"path": "b.ts"}'),
      ],
    }));

    const events = await collect(openaiClient("k", "m", fake.api as any));

    expect(events.filter((event) => event.type === "tool_call")).toMatchObject([
      { id: "call_1", arguments: { path: "a.ts" } },
      { id: "call_2", arguments: { path: "b.ts" } },
    ]);
  });

  /**
   * A tool taking no arguments sends an empty string, and a truncated response
   * can send an unparseable one. Neither ends the turn: the model sees the
   * tool's own complaint about what is missing and can correct it, which is the
   * behaviour the loop is built around.
   */
  test("empty and malformed arguments become an empty object", async () => {
    const fake = fakeOpenAI(() => ({
      events: [
        ...functionCallItem(0, "call_1", "list_files", ""),
        ...functionCallItem(1, "call_2", "read_file", '{"path": '),
      ],
    }));

    const events = await collect(openaiClient("k", "m", fake.api as any));

    expect(events.filter((event) => event.type === "tool_call")).toMatchObject([
      { id: "call_1", arguments: {} },
      { id: "call_2", arguments: {} },
    ]);
  });

  /**
   * Every count maps straight across. Worth asserting rather than assuming,
   * because the Anthropic client next door has to sum three fields to get the
   * same number: there `input_tokens` excludes the cache, here it contains it,
   * and reading one client's rule into the other under-reports every cached
   * turn.
   */
  test("reports the provider's own token counts", async () => {
    const fake = fakeOpenAI(() => ({
      events: [...textItem(0, "ok")],
      usage: {
        input_tokens: 1_000,
        input_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 },
        output_tokens: 120,
        output_tokens_details: { reasoning_tokens: 90 },
        total_tokens: 1_120,
      },
    }));

    const events = await collect(openaiClient("k", "m", fake.api as any));

    expect(events.at(-1)).toEqual({
      type: "done",
      usage: {
        promptTokens: 1_000,
        completionTokens: 120,
        cachedTokens: 800,
        thoughtTokens: 90,
        totalTokens: 1_120,
      },
    });
  });

  test("usage the provider did not report is missing, not zero", async () => {
    const fake = fakeOpenAI(() => ({ events: [...textItem(0, "ok")], withoutUsage: true }));

    const events = await collect(openaiClient("k", "m", fake.api as any));

    expect(events.at(-1)).toEqual({ type: "done", usage: undefined });
  });

  test("a transient failure is retried until it succeeds", async () => {
    const fake = fakeOpenAI((attempt) =>
      attempt < 3
        ? {
            events: [],
            throwBeforeStream: new Error("The socket connection was closed unexpectedly."),
          }
        : { events: [...textItem(0, "recovered")] },
    );

    const events = await collect(openaiClient("k", "m", fake.api as any));

    expect(fake.requests).toHaveLength(3);
    expect(events.filter((event) => event.type === "retry")).toHaveLength(2);
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", content: "recovered" },
    ]);
    expect(events.at(-1)!.type).toBe("done");
  });

  /**
   * After the first chunk the caller has already printed the text, so repeating
   * the request would duplicate output the user watched arrive.
   */
  test("a failure after output has streamed is not retried", async () => {
    const fake = fakeOpenAI(() => ({
      events: [...textItem(0, "partial")],
      throwAfterEvents: new Error("The socket connection was closed unexpectedly."),
    }));

    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of openaiClient("k", "m", fake.api as any).stream(ask, "")) {
          events.push(event);
        }
      })(),
    ).rejects.toThrow(/socket connection/);

    expect(fake.requests).toHaveLength(1);
    expect(events.filter((event) => event.type === "retry")).toHaveLength(0);
    expect(events.filter((event) => event.type === "text")).toHaveLength(1);
  });

  test("a cancelled turn is never retried", async () => {
    const controller = new AbortController();
    const fake = fakeOpenAI(() => {
      controller.abort();
      return {
        events: [],
        throwBeforeStream: new Error("The socket connection was closed unexpectedly."),
      };
    });

    await expect(
      (async () => {
        for await (const _ of openaiClient("k", "m", fake.api as any).stream(
          ask,
          "",
          controller.signal,
        )) {
          // drain
        }
      })(),
    ).rejects.toThrow();

    expect(fake.requests).toHaveLength(1);
  });

  test("cancelling the turn aborts the request in flight", async () => {
    const controller = new AbortController();
    const fake = fakeOpenAI(() => ({ events: [...textItem(0, "one", "two")] }));

    let requestSignal: AbortSignal | undefined;
    for await (const event of openaiClient("k", "m", fake.api as any).stream(
      ask,
      "",
      controller.signal,
    )) {
      if (event.type !== "text") continue;
      requestSignal = fake.options[0].signal;
      expect(requestSignal!.aborted).toBe(false);
      controller.abort();
      break;
    }

    expect(requestSignal!.aborted).toBe(true);
  });

  test("a finished request stops listening to the turn's signal", async () => {
    const controller = new AbortController();
    const fake = fakeOpenAI(() => ({ events: [...textItem(0, "hi")] }));

    await collect(openaiClient("k", "m", fake.api as any), ask, controller.signal);
    controller.abort();

    expect((fake.options[0].signal as AbortSignal).aborted).toBe(false);
  });
});

describe("reasoning replay", () => {
  const withCall: Message[] = [
    { role: "user", content: "Read it" },
    {
      role: "assistant_tool_call",
      toolName: "read_file",
      toolCallId: "call_1",
      arguments: { path: "a.ts" },
    },
    { role: "tool", toolName: "read_file", toolCallId: "call_1", content: "contents" },
  ];

  /**
   * The item has to be read from `response.output_item.done`. On `.added` — the
   * event that announces the same item — `encrypted_content` is not yet
   * populated, so a client capturing there replays an empty husk. Nothing about
   * that fails loudly: the request is accepted and the model simply reasons
   * from less than it had.
   *
   * The fixture sends both events, so this passes only if the later one is the
   * one kept.
   */
  test("reasoning is replayed with the call it preceded, carrying its ciphertext", async () => {
    const fake = fakeOpenAI((attempt) =>
      attempt === 1
        ? {
            events: [
              ...reasoningItem(0, "encrypted-blob"),
              ...functionCallItem(1, "call_1", "read_file", '{"path": "a.ts"}'),
            ],
          }
        : { events: [...textItem(0, "done")] },
    );

    const client = openaiClient("k", "m", fake.api as any);
    await collect(client, ask);
    await collect(client, withCall);

    const replayed = fake.requests[1].input.filter(
      (item: { type: string }) => item.type === "reasoning",
    );
    expect(replayed).toHaveLength(1);
    expect(replayed[0].encrypted_content).toBe("encrypted-blob");
  });

  test("the reasoning item comes before the call it belongs to", async () => {
    const fake = fakeOpenAI((attempt) =>
      attempt === 1
        ? {
            events: [
              ...reasoningItem(0, "encrypted-blob"),
              ...functionCallItem(1, "call_1", "read_file", '{"path": "a.ts"}'),
            ],
          }
        : { events: [...textItem(0, "done")] },
    );

    const client = openaiClient("k", "m", fake.api as any);
    await collect(client, ask);
    await collect(client, withCall);

    const types = fake.requests[1].input.map((item: { type?: string }) => item.type);
    expect(types.indexOf("reasoning")).toBeLessThan(types.indexOf("function_call"));
  });

  /**
   * A response that reasoned about nothing still has to render, and the map is
   * scoped to one client — a turn that never saw a reasoning item sends none
   * rather than reaching for another turn's.
   */
  test("a turn without reasoning replays nothing", async () => {
    const fake = fakeOpenAI(() => ({ events: [...textItem(0, "done")] }));

    await collect(openaiClient("k", "m", fake.api as any), withCall);

    expect(
      fake.requests[0].input.filter((item: { type: string }) => item.type === "reasoning"),
    ).toHaveLength(0);
  });
});

describe("rendering the conversation", () => {
  test("a call and its result are siblings, matched on call_id", () => {
    const input = buildOpenAIInput([
      { role: "user", content: "Read it" },
      {
        role: "assistant_tool_call",
        toolName: "read_file",
        toolCallId: "call_1",
        arguments: { path: "a.ts" },
      },
      { role: "tool", toolName: "read_file", toolCallId: "call_1", content: "contents" },
    ]);

    expect(input).toEqual([
      { role: "user", content: "Read it" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: '{"path":"a.ts"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "contents" },
    ]);
  });

  test("a batch keeps its calls together, then their results", () => {
    const input = buildOpenAIInput([
      {
        role: "assistant_tool_call",
        toolName: "read_file",
        toolCallId: "call_1",
        arguments: { path: "a.ts" },
        batchId: "batch",
      },
      {
        role: "assistant_tool_call",
        toolName: "read_file",
        toolCallId: "call_2",
        arguments: { path: "b.ts" },
        batchId: "batch",
      },
      { role: "tool", toolName: "read_file", toolCallId: "call_1", content: "a" },
      { role: "tool", toolName: "read_file", toolCallId: "call_2", content: "b" },
    ]);

    expect(input.map((item: any) => [item.type, item.call_id])).toEqual([
      ["function_call", "call_1"],
      ["function_call", "call_2"],
      ["function_call_output", "call_1"],
      ["function_call_output", "call_2"],
    ]);
  });

  /**
   * The turn was cancelled between the call and its result. The call is still
   * in the history, so it is answered with a placeholder rather than dropped —
   * the model is told the call ended, instead of being left waiting on one that
   * never comes back.
   */
  test("a call whose result never arrived is still answered", () => {
    const input = buildOpenAIInput([
      {
        role: "assistant_tool_call",
        toolName: "read_file",
        toolCallId: "call_1",
        arguments: {},
      },
    ]);

    expect(input.at(-1)).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "Tool execution did not complete.",
    });
  });

  test("a tool that returned nothing says so", () => {
    const input = buildOpenAIInput([
      {
        role: "assistant_tool_call",
        toolName: "write_file",
        toolCallId: "call_1",
        arguments: {},
      },
      { role: "tool", toolName: "write_file", toolCallId: "call_1", content: "" },
    ]);

    expect(input.at(-1)).toMatchObject({ output: "(no output)" });
  });

  /** The API rejects an empty message, and it says nothing worth a token. */
  test("an assistant turn that streamed only tool calls is dropped", () => {
    const input = buildOpenAIInput([
      { role: "user", content: "go" },
      { role: "assistant", content: "   " },
    ]);

    expect(input).toEqual([{ role: "user", content: "go" }]);
  });

  /**
   * A result whose call fell outside the history window. Rendering it as a
   * `function_call_output` would name a call this request never makes, so it is
   * described in a message instead.
   */
  test("an orphaned result is described rather than matched", () => {
    const input = buildOpenAIInput([
      { role: "tool", toolName: "read_file", toolCallId: "call_gone", content: "contents" },
    ]);

    expect(input).toEqual([
      { role: "user", content: "Result of an earlier read_file call:\ncontents" },
    ]);
  });
});

/**
 * The client against the real SDK, with only the socket faked.
 *
 * Every test above injects a stand-in for `responses.stream`, which proves what
 * the client does with a stream but assumes the stand-in yields what the SDK
 * yields. That assumption is the one thing those tests cannot check, and it is
 * the one that fails silently: an event written by hand from the type
 * declarations passes a fake and drops a tool call against the real thing.
 *
 * So this drives the actual `openai` SDK over a stubbed `globalThis.fetch`
 * serving an SSE body. The SDK does its own framing, parsing and accumulation;
 * what arrives at the client is whatever it really produces. `globalThis.fetch`
 * is writable and restored per test, so this needs no module mock and cannot
 * leak into another file the way `mock.module` would.
 */
describe("the real SDK, over a faked socket", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Serves an SSE body and records the request the SDK built. */
  function stubFetch(body: string, status = 200) {
    const seen: { url: string; init: RequestInit }[] = [];

    globalThis.fetch = Object.assign(
      async (input: any, init: any) => {
        seen.push({ url: String(input), init });
        return new Response(body, {
          status,
          headers: { "content-type": "text/event-stream" },
        });
      },
      { preconnect: realFetch.preconnect },
    ) as typeof globalThis.fetch;

    return seen;
  }

  function sse(events: unknown[]): string {
    return events
      .map(
        (event, index) =>
          `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify({
            ...(event as object),
            sequence_number: index,
          })}\n\n`,
      )
      .join("");
  }

  function response(output: unknown[]) {
    return {
      id: "resp_1",
      object: "response",
      created_at: 0,
      status: "completed",
      model: "gpt-5.5",
      output,
      parallel_tool_calls: true,
      tool_choice: "auto",
      tools: [],
      usage: {
        input_tokens: 12,
        input_tokens_details: { cached_tokens: 4, cache_write_tokens: 0 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 3 },
        total_tokens: 19,
      },
    };
  }

  /** A response that says something and then calls a tool. */
  function answerAndCall() {
    const message = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Reading.", annotations: [] }],
    };
    const call = {
      id: "fc_1",
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path": "README.md"}',
      status: "completed",
    };

    return sse([
      { type: "response.created", response: response([]) },
      { type: "response.in_progress", response: response([]) },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: "Reading.",
      },
      {
        type: "response.content_part.done",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "Reading.", annotations: [] },
      },
      { type: "response.output_item.done", output_index: 0, item: message },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { ...call, status: "in_progress", arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        output_index: 1,
        delta: '{"path": "README.md"}',
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        output_index: 1,
        arguments: '{"path": "README.md"}',
      },
      { type: "response.output_item.done", output_index: 1, item: call },
      { type: "response.completed", response: response([message, call]) },
    ]);
  }

  test("text and a tool call survive the SDK's own parsing", async () => {
    stubFetch(answerAndCall());

    const events: StreamEvent[] = [];
    for await (const event of openaiClient("sk-test", "gpt-5.5").stream(ask, "")) {
      events.push(event);
    }

    expect(events).toMatchObject([
      { type: "text", content: "Reading." },
      { type: "tool_call", id: "call_1", name: "read_file", arguments: { path: "README.md" } },
      {
        type: "done",
        usage: { promptTokens: 12, cachedTokens: 4, thoughtTokens: 3, totalTokens: 19 },
      },
    ]);
  });

  test("the request the SDK builds is stateless and carries the tools", async () => {
    const seen = stubFetch(answerAndCall());

    for await (const _ of openaiClient("sk-test", "gpt-5.5").stream(ask, "")) {
      // drain
    }

    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body.store).toBe(false);
    expect(body.instructions).toBeString();
    expect(body.tools.map((tool: { name: string }) => tool.name)).toContain("read_file");
  });

  /**
   * providers.json stores the provider and the model independently, so
   * switching provider on the command line leaves the previous provider's model
   * selected — `woopcode providers set -p openai` does not touch it. Sent as
   * given, that is a 404 on the first turn of a freshly switched session.
   */
  test("a model belonging to another provider is replaced before it reaches the wire", async () => {
    const seen = stubFetch(answerAndCall());

    const client = createProviderClient("openai", "sk-test", "gemini-3.5-flash-lite");
    for await (const _ of client.stream(ask, "")) {
      // drain
    }

    expect(JSON.parse(String(seen[0]!.init.body)).model).toBe(defaultModelForProvider("openai"));
  });

  /**
   * The catalog is a convenience list, not an allowlist. A model released after
   * this build should reach OpenAI and get OpenAI's own answer, rather than
   * being quietly swapped for one this build happens to know.
   */
  test("a model the catalog has never heard of is passed through untouched", async () => {
    const seen = stubFetch(answerAndCall());

    const client = createProviderClient("openai", "sk-test", "gpt-6-turbo");
    for await (const _ of client.stream(ask, "")) {
      // drain
    }

    expect(JSON.parse(String(seen[0]!.init.body)).model).toBe("gpt-6-turbo");
  });

  /**
   * The SDK retries 429s and 5xx twice by default, and this codebase already
   * has a retry policy in runtime/retry.ts. Left at the default, every attempt
   * the loop counted would silently have been three, with two sets of delays
   * compounding — so the client turns the SDK's off, and this counts the
   * requests that actually reach the socket to prove it.
   */
  test("retrying is this codebase's job, not the SDK's", async () => {
    const seen = stubFetch("", 500);

    await expect(
      (async () => {
        for await (const _ of openaiClient("sk-test", "gpt-5.5").stream(ask, "")) {
          // drain
        }
      })(),
    ).rejects.toThrow();

    // One per attempt this codebase makes, with none of the SDK's own added.
    expect(seen).toHaveLength(maxAttempts());
  });
});
