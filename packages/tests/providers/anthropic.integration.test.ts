import { describe, expect, test } from "bun:test";
import { anthropicClient, anthropicThinking } from "../../../providers/anthropicClient";
import type { Message, StreamEvent } from "../../../config/types";
import {
  fakeAnthropic,
  messageStart,
  messageStop,
  ping,
  textBlock,
  thinkingBlock,
  toolBlock,
} from "../shared/anthropicStream";

const ask: Message[] = [{ role: "user", content: "Inspect the project" }];

async function collect(
  client: ReturnType<typeof anthropicClient>,
  messages: Message[] = ask,
  signal?: AbortSignal,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of client.stream(messages, "repo", signal)) {
    events.push(event);
  }
  return events;
}

describe("thinking configuration", () => {
  test("off is the one value that disables thinking", () => {
    expect(anthropicThinking({ WOOPCODE_THINKING_BUDGET: "off" })).toEqual({ type: "disabled" });
  });

  /**
   * The variable was designed for Gemini, where it is a token count. Anthropic
   * rejects `budget_tokens` outright, so a number cannot be honoured as one —
   * and inventing a mapping would report a budget that was never applied.
   * Every non-`off` value means the same thing here: let the model decide.
   */
  test("a token count means adaptive rather than a budget Anthropic would reject", () => {
    const adaptive = { type: "adaptive", display: "omitted" } as const;

    expect(anthropicThinking({})).toEqual(adaptive);
    expect(anthropicThinking({ WOOPCODE_THINKING_BUDGET: "2048" })).toEqual(adaptive);
    expect(anthropicThinking({ WOOPCODE_THINKING_BUDGET: "-1" })).toEqual(adaptive);
  });
});

describe("Anthropic provider adapter", () => {
  test("serializes tool schemas and caches the system prompt", async () => {
    const fake = fakeAnthropic(() => ({ events: [...textBlock(0, "ok")] }));

    await collect(anthropicClient("k", "claude-opus-5", fake.api as any));

    const request = fake.requests[0];
    expect(request.model).toBe("claude-opus-5");
    expect(request.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(request.system[0].text).toContain("Repository Context:");

    const askUser = request.tools.find((tool: { name: string }) => tool.name === "ask_user");
    expect(askUser.input_schema).toMatchObject({
      type: "object",
      properties: { questions: { type: "array", items: { type: "string" } } },
    });
    expect(askUser.input_schema.required).toContain("questions");
  });

  test("no tools are sent when the caller asks for none", async () => {
    const fake = fakeAnthropic(() => ({ events: [...textBlock(0, "ok")] }));

    for await (const _ of anthropicClient("k", "m", fake.api as any).stream(
      ask,
      "",
      undefined,
      false,
    )) {
      // drain
    }

    expect(fake.requests[0].tools).toBeUndefined();
  });

  /**
   * Tool arguments arrive as fragments of a JSON string, split at arbitrary
   * points — mid-key and mid-value are both normal — and are only parseable
   * once the block closes. Parsing a fragment, or treating each as a call,
   * would corrupt every argument the model sends.
   */
  test("reassembles tool arguments split across deltas", async () => {
    const fake = fakeAnthropic(() => ({
      events: [
        messageStart(),
        ...textBlock(0, "Let me look."),
        ping,
        ...toolBlock(1, "toolu_1", "read_file", "", '{"path"', ': "READ', 'ME.md"}'),
        ...messageStop(),
      ],
    }));

    const events = await collect(anthropicClient("k", "m", fake.api as any));

    expect(events).toMatchObject([
      { type: "text", content: "Let me look." },
      { type: "tool_call", id: "toolu_1", name: "read_file", arguments: { path: "README.md" } },
      { type: "done" },
    ]);
  });

  test("keeps every call of a parallel batch, in order", async () => {
    const fake = fakeAnthropic(() => ({
      events: [
        ...toolBlock(0, "toolu_1", "read_file", '{"path": "a.ts"}'),
        ...toolBlock(1, "toolu_2", "read_file", '{"path": "b.ts"}'),
      ],
    }));

    const events = await collect(anthropicClient("k", "m", fake.api as any));

    expect(events.filter((event) => event.type === "tool_call")).toMatchObject([
      { id: "toolu_1", arguments: { path: "a.ts" } },
      { id: "toolu_2", arguments: { path: "b.ts" } },
    ]);
  });

  /**
   * A tool taking no arguments produces no fragments, or a single empty one.
   * `JSON.parse("")` throws, so the empty case has to be answered before
   * parsing rather than caught after it.
   */
  test("a call with no arguments is an empty object, not a parse error", async () => {
    const fake = fakeAnthropic(() => ({
      events: [...toolBlock(0, "toolu_1", "list_files"), ...toolBlock(1, "toolu_2", "list_files", "")],
    }));

    const events = await collect(anthropicClient("k", "m", fake.api as any));

    expect(events.filter((event) => event.type === "tool_call")).toMatchObject([
      { id: "toolu_1", arguments: {} },
      { id: "toolu_2", arguments: {} },
    ]);
  });

  /**
   * A truncated stream can close a tool block mid-JSON. The call still reaches
   * the model's own tool, which answers that its arguments are missing — the
   * correction the loop is built around. Throwing would end the turn instead.
   */
  test("unparseable arguments reach the tool rather than ending the turn", async () => {
    const fake = fakeAnthropic(() => ({
      events: [...toolBlock(0, "toolu_1", "read_file", '{"path": "READ')],
    }));

    const events = await collect(anthropicClient("k", "m", fake.api as any));

    expect(events).toMatchObject([
      { type: "tool_call", id: "toolu_1", name: "read_file", arguments: {} },
      { type: "done" },
    ]);
  });

  test("reasoning is never streamed to the terminal", async () => {
    const fake = fakeAnthropic(() => ({
      events: [
        ...thinkingBlock(0, "sig-1", "I should read the file first."),
        ...textBlock(1, "Reading."),
      ],
    }));

    const events = await collect(anthropicClient("k", "m", fake.api as any));

    // A thought is the model's scratchpad, not its answer. Yielding it would
    // print it and persist it as assistant text.
    expect(events).toEqual([
      { type: "text", content: "Reading." },
      { type: "done", usage: expect.anything() },
    ]);
  });

  /**
   * `input_tokens` excludes everything served from cache, so reading it as the
   * prompt size under-reports exactly the turns the cache marker is there to
   * make cheap. promptTokens is the whole prompt, with cachedTokens a subset of
   * it — the same relationship the Gemini client reports.
   */
  test("reports the whole prompt, with the cached part as a subset of it", async () => {
    const fake = fakeAnthropic(() => ({
      events: [...textBlock(0, "hi")],
      usage: {
        input_tokens: 300,
        output_tokens: 45,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 9000,
      },
    }));

    const events = await collect(anthropicClient("k", "m", fake.api as any));

    expect(events.at(-1)).toEqual({
      type: "done",
      usage: {
        promptTokens: 9500,
        completionTokens: 45,
        cachedTokens: 9000,
        totalTokens: 9545,
      },
    });
  });

  test("a cache miss is reported as no cached tokens rather than zero-ish noise", async () => {
    const fake = fakeAnthropic(() => ({
      events: [...textBlock(0, "hi")],
      usage: { input_tokens: 120, output_tokens: 4 },
    }));

    const events = await collect(anthropicClient("k", "m", fake.api as any));

    expect(events.at(-1)).toEqual({
      type: "done",
      usage: {
        promptTokens: 120,
        completionTokens: 4,
        cachedTokens: undefined,
        totalTokens: 124,
      },
    });
  });

  /**
   * Tier 1: a request that fails before yielding anything is safe to repeat,
   * because nothing has been observed.
   */
  test("a transient failure before any output is retried", async () => {
    const fake = fakeAnthropic((attempt) =>
      attempt < 3
        ? { events: [], throwBeforeStream: new Error("The socket connection was closed unexpectedly.") }
        : { events: [...textBlock(0, "recovered")] },
    );

    const events = await collect(anthropicClient("k", "m", fake.api as any));

    expect(fake.requests).toHaveLength(3);
    expect(events.filter((event) => event.type === "retry")).toHaveLength(2);
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", content: "recovered" },
    ]);
    expect(events.at(-1)!.type).toBe("done");
  });

  /**
   * Tier 1 stops at the first chunk. After that the caller has already printed
   * the text, so repeating the request would duplicate output the user watched
   * arrive.
   */
  test("a failure after output has streamed is not retried", async () => {
    const fake = fakeAnthropic(() => ({
      events: [...textBlock(0, "partial")],
      throwAfterEvents: new Error("The socket connection was closed unexpectedly."),
    }));

    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of anthropicClient("k", "m", fake.api as any).stream(ask, "")) {
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
    const fake = fakeAnthropic(() => {
      controller.abort();
      return { events: [], throwBeforeStream: new Error("The socket connection was closed unexpectedly.") };
    });

    await expect(
      (async () => {
        for await (const _ of anthropicClient("k", "m", fake.api as any).stream(
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
    const fake = fakeAnthropic(() => ({ events: [...textBlock(0, "one", "two")] }));

    let requestSignal: AbortSignal | undefined;
    for await (const event of anthropicClient("k", "m", fake.api as any).stream(
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

  /**
   * The listener and the timeout are torn down when the request ends, so a
   * turn cancelled later cannot reach a request that already finished. Left
   * attached, every iteration of a long turn would add another listener to the
   * same signal and abort a stream that had nothing to do with it.
   */
  test("a finished request stops listening to the turn's signal", async () => {
    const controller = new AbortController();
    const fake = fakeAnthropic(() => ({ events: [...textBlock(0, "hi")] }));

    await collect(anthropicClient("k", "m", fake.api as any), ask, controller.signal);
    controller.abort();

    expect((fake.options[0].signal as AbortSignal).aborted).toBe(false);
  });
});
