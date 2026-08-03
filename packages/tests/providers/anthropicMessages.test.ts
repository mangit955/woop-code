import { describe, expect, test } from "bun:test";
import { anthropicClient, buildAnthropicMessages } from "../../../config/anthropicClient";
import type { Message } from "../../../config/types";
import { fakeAnthropic, textBlock, thinkingBlock, toolBlock } from "../shared/anthropicStream";

/**
 * The loop stores a tool call and its result as separate messages, and a model
 * that asks for several tools at once produces several of them. Anthropic will
 * not accept that shape replayed literally: every `tool_use` block of an
 * assistant turn has to be answered by a `tool_result` in the single user
 * message that follows it.
 */
describe("rendering the conversation", () => {
  test("plain turns keep their roles", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
    ];

    expect(buildAnthropicMessages(messages)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
    ]);
  });

  /**
   * A turn that streamed nothing but tool calls leaves an empty assistant
   * message behind, and the API rejects empty content outright — so this is a
   * dropped message rather than a tidied one.
   */
  test("an assistant turn with no text is dropped rather than sent empty", () => {
    expect(
      buildAnthropicMessages([
        { role: "user", content: "hello" },
        { role: "assistant", content: "   " },
      ]),
    ).toEqual([{ role: "user", content: "hello" }]);
  });

  test("a batch becomes one assistant turn and one user turn", () => {
    const messages: Message[] = [
      { role: "user", content: "read both" },
      {
        role: "assistant_tool_call",
        toolName: "read_file",
        toolCallId: "toolu_1",
        arguments: { path: "a.ts" },
        batchId: "batch-1",
      },
      {
        role: "assistant_tool_call",
        toolName: "read_file",
        toolCallId: "toolu_2",
        arguments: { path: "b.ts" },
        batchId: "batch-1",
      },
      { role: "tool", toolName: "read_file", toolCallId: "toolu_1", content: "A" },
      { role: "tool", toolName: "read_file", toolCallId: "toolu_2", content: "B" },
    ];

    expect(buildAnthropicMessages(messages)).toEqual([
      { role: "user", content: "read both" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } },
          { type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "b.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "A" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "B" },
        ],
      },
    ]);
  });

  /**
   * A turn cancelled between the call and its result leaves a `tool_use` with
   * no answer, which the API refuses. Saying the tool did not finish is the
   * honest reconstruction; dropping the call would rewrite history, and
   * dropping nothing would fail the request.
   */
  test("a call whose result never arrived is answered as unfinished", () => {
    const [, , result] = buildAnthropicMessages([
      { role: "user", content: "read it" },
      {
        role: "assistant_tool_call",
        toolName: "read_file",
        toolCallId: "toolu_1",
        arguments: { path: "a.ts" },
      },
    ]);

    expect(result).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true }],
    });
  });

  test("a tool that produced no output says so rather than sending nothing", () => {
    const [, , result] = buildAnthropicMessages([
      { role: "user", content: "run it" },
      {
        role: "assistant_tool_call",
        toolName: "run_terminal",
        toolCallId: "toolu_1",
        arguments: {},
      },
      { role: "tool", toolName: "run_terminal", toolCallId: "toolu_1", content: "" },
    ]);

    expect(result).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "(no output)" }],
    });
  });

  test("reasoning captured for a call is replayed ahead of it, unmodified", () => {
    const reasoning = new Map([
      ["toolu_1", [{ type: "thinking" as const, thinking: "", signature: "sig-abc" }]],
    ]);

    const [assistant] = buildAnthropicMessages(
      [
        {
          role: "assistant_tool_call",
          toolName: "read_file",
          toolCallId: "toolu_1",
          arguments: { path: "a.ts" },
        },
        { role: "tool", toolName: "read_file", toolCallId: "toolu_1", content: "A" },
      ],
      reasoning,
    );

    expect(assistant).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig-abc" },
        { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } },
      ],
    });
  });
});

/**
 * The requirement this guards is easy to miss because breaking it is silent:
 * when tool results come back, the reasoning that led to the call must come
 * back with them. Omitting it does not fail the request — the API quietly runs
 * that turn without thinking instead, so the only symptom is a worse answer.
 *
 * The signature is what carries it. It is captured on the iteration that
 * produced the call and replayed on the next one, so this needs two turns
 * through the same client to test at all.
 */
describe("reasoning continuity across a tool-use turn", () => {
  test("the signature from one iteration is sent back with the next", async () => {
    const fake = fakeAnthropic((attempt) =>
      attempt === 1
        ? {
            events: [
              ...thinkingBlock(0, "sig-from-turn-one"),
              ...toolBlock(1, "toolu_1", "read_file", '{"path": "a.ts"}'),
            ],
          }
        : { events: [...textBlock(0, "It says A.")] },
    );

    const client = anthropicClient("k", "m", fake.api as any);
    const history: Message[] = [{ role: "user", content: "read a.ts" }];

    for await (const event of client.stream(history, "")) {
      if (event.type === "tool_call") {
        history.push({
          role: "assistant_tool_call",
          toolName: event.name,
          toolCallId: event.id,
          arguments: event.arguments,
          batchId: "batch-1",
        });
      }
    }
    history.push({ role: "tool", toolName: "read_file", toolCallId: "toolu_1", content: "A" });

    for await (const _ of client.stream(history, "")) {
      // drain
    }

    expect(fake.requests[1].messages).toEqual([
      { role: "user", content: "read a.ts" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig-from-turn-one" },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "A" }] },
    ]);
  });

  test("a response with no reasoning sends none, rather than an empty block", async () => {
    const fake = fakeAnthropic((attempt) =>
      attempt === 1
        ? { events: [...toolBlock(0, "toolu_1", "read_file", '{"path": "a.ts"}')] }
        : { events: [...textBlock(0, "It says A.")] },
    );

    const client = anthropicClient("k", "m", fake.api as any);
    const history: Message[] = [{ role: "user", content: "read a.ts" }];

    for await (const _ of client.stream(history, "")) {
      // drain
    }
    history.push(
      {
        role: "assistant_tool_call",
        toolName: "read_file",
        toolCallId: "toolu_1",
        arguments: { path: "a.ts" },
      },
      { role: "tool", toolName: "read_file", toolCallId: "toolu_1", content: "A" },
    );

    for await (const _ of client.stream(history, "")) {
      // drain
    }

    expect(fake.requests[1].messages[1].content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } },
    ]);
  });

  /**
   * Every call of a batch shares the response's reasoning, because the model
   * signs the response rather than the individual call. Attaching it to only
   * the first would send an assistant turn whose blocks no longer match what
   * the model produced.
   */
  test("every call of one response carries that response's reasoning", async () => {
    const fake = fakeAnthropic((attempt) =>
      attempt === 1
        ? {
            events: [
              ...thinkingBlock(0, "sig-batch"),
              ...toolBlock(1, "toolu_1", "read_file", '{"path": "a.ts"}'),
              ...toolBlock(2, "toolu_2", "read_file", '{"path": "b.ts"}'),
            ],
          }
        : { events: [...textBlock(0, "done")] },
    );

    const client = anthropicClient("k", "m", fake.api as any);
    const history: Message[] = [{ role: "user", content: "read both" }];

    for await (const _ of client.stream(history, "")) {
      // drain
    }
    history.push(
      {
        role: "assistant_tool_call",
        toolName: "read_file",
        toolCallId: "toolu_2",
        arguments: { path: "b.ts" },
        batchId: "batch-1",
      },
      { role: "tool", toolName: "read_file", toolCallId: "toolu_2", content: "B" },
    );

    for await (const _ of client.stream(history, "")) {
      // drain
    }

    // Rendered from the second call's id alone: the reasoning is keyed by every
    // call of the response, not only the first one seen.
    expect(fake.requests[1].messages[1].content[0]).toEqual({
      type: "thinking",
      thinking: "",
      signature: "sig-batch",
    });
  });
});
