import { afterEach, describe, expect, test } from "bun:test";
import { readFileTool } from "../../../tools/readFile";
import { createProviderClient } from "../../../providers/client";
import type { Message, StreamEvent } from "../../../config/types";

/**
 * Two iterations of a tool-using turn, with only the socket faked.
 *
 * Every other test here stops at one request. This one runs the round trip the
 * product depends on: Claude asks for a tool, the tool executes against a real
 * file, and the result goes back in a second request that the API either
 * accepts or rejects outright. The second request is the part worth proving —
 * a client that streams text perfectly can still fail there, because that is
 * where the batching rule and the reasoning replay apply.
 *
 * The tool is imported directly rather than resolved through `tools/index`,
 * and the loop's message-appending is reproduced here rather than driven
 * through `agentLoop`. Four test files register a global `mock.module` over
 * the tool registry, and Bun keeps module mocks for the whole run — so a test
 * that resolves a tool through the registry passes or fails on which file
 * loaded last. `packages/tests/providers/anthropicHistory.test.ts` covers the
 * loop's own appending, against every window it can produce.
 */
describe("a tool round trip against Anthropic", () => {
  const realFetch = globalThis.fetch;
  const cwd = process.cwd();

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.chdir(cwd);
  });

  function sse(events: unknown[]): string {
    return events
      .map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
  }

  function response(id: string, blocks: unknown[], stopReason: string): string {
    return sse([
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 500, output_tokens: 1, cache_read_input_tokens: 400 },
        },
      },
      ...blocks,
      {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 30 },
      },
      { type: "message_stop" },
    ]);
  }

  test("the result of a real tool call comes back in a request the API accepts", async () => {
    const workspace = await Bun.$`mktemp -d`.text().then((path) => path.trim());
    await Bun.write(`${workspace}/version.txt`, "0.6.4\n");
    process.chdir(workspace);

    const bodies: any[] = [];
    globalThis.fetch = Object.assign(
      async (_input: any, init: any) => {
        bodies.push(JSON.parse(String(init.body)));

        const body =
          bodies.length === 1
            ? response(
                "msg_01",
                [
                  // Reasoning arrives first, exactly as it does under the
                  // default display: a signature and no text.
                  {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "thinking", thinking: "", signature: "" },
                  },
                  {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "signature_delta", signature: "sig-turn-1" },
                  },
                  { type: "content_block_stop", index: 0 },
                  {
                    type: "content_block_start",
                    index: 1,
                    content_block: { type: "tool_use", id: "toolu_01", name: "read_file", input: {} },
                  },
                  {
                    type: "content_block_delta",
                    index: 1,
                    delta: { type: "input_json_delta", partial_json: '{"path": "vers' },
                  },
                  {
                    type: "content_block_delta",
                    index: 1,
                    delta: { type: "input_json_delta", partial_json: 'ion.txt"}' },
                  },
                  { type: "content_block_stop", index: 1 },
                ],
                "tool_use",
              )
            : response(
                "msg_02",
                [
                  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                  {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "The version is 0.6.4." },
                  },
                  { type: "content_block_stop", index: 0 },
                ],
                "end_turn",
              );

        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
      { preconnect: realFetch.preconnect },
    ) as typeof globalThis.fetch;

    // One client for the whole turn, as the controller builds it — which is
    // what lets the reasoning captured in the first iteration reach the second.
    const client = createProviderClient("anthropic", "sk-test", "claude-opus-5");
    const history: Message[] = [{ role: "user", content: "what version is this?" }];

    // Iteration one: the model asks for a tool.
    const first: StreamEvent[] = [];
    for await (const event of client.stream(history, "repo context")) first.push(event);

    const call = first.find((event) => event.type === "tool_call");
    expect(call).toMatchObject({ name: "read_file", arguments: { path: "version.txt" } });

    // The tool runs for real, against a real file.
    const output = await readFileTool.execute(call!.arguments);
    expect(output).toContain("0.6.4");

    history.push(
      {
        role: "assistant_tool_call",
        toolName: call!.name,
        toolCallId: call!.id,
        arguments: call!.arguments,
        batchId: crypto.randomUUID(),
      },
      { role: "tool", toolName: call!.name, toolCallId: call!.id, content: output },
    );

    // Iteration two: the result goes back and the model answers from it.
    let answer = "";
    for await (const event of client.stream(history, "repo context")) {
      if (event.type === "text") answer += event.content;
    }

    expect(answer).toBe("The version is 0.6.4.");
    expect(bodies).toHaveLength(2);

    // The shape the API would reject if it were wrong: reasoning ahead of the
    // call it belonged to, and the very next message answering that call.
    const [, second] = bodies;
    expect(second.messages[0]).toEqual({ role: "user", content: "what version is this?" });
    expect(second.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig-turn-1" },
        { type: "tool_use", id: "toolu_01", name: "read_file", input: { path: "version.txt" } },
      ],
    });
    expect(second.messages[2].role).toBe("user");
    expect(second.messages[2].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_01",
    });
    expect(second.messages[2].content[0].content).toContain("0.6.4");

    // The cached prefix is marked on both requests and is byte-identical, which
    // is what makes the second one a cache read rather than a second write.
    expect(second.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(second.system[0].text).toBe(bodies[0].system[0].text);

    await Bun.$`rm -rf ${workspace}`.quiet();
  });
});
