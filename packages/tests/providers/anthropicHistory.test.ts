import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { buildAnthropicMessages } from "../../../config/anthropicClient";
import { recentMessages } from "../../../config/config";
import type { Message } from "../../../config/types";

/**
 * What the loop actually sends, put through the renderer.
 *
 * The rules Anthropic enforces are about the request as a whole, not about any
 * one message: the first turn must be a user turn, and every `tool_use` block
 * must be answered by a `tool_result` in the user message that immediately
 * follows it. Breaking either is a 400 that ends the turn, and neither is
 * visible from a test that renders a handful of messages by hand.
 *
 * So this asserts the invariants against histories shaped like the ones the
 * loop builds, windowed by the real `recentMessages` — the step between the
 * loop and the client, and the one that could orphan a result by cutting a
 * conversation in the wrong place.
 */
function assertWellFormed(rendered: Anthropic.MessageParam[]) {
  expect(rendered[0]?.role).toBe("user");

  for (const [index, message] of rendered.entries()) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;

    const calls = message.content.filter((block) => block.type === "tool_use");
    if (calls.length === 0) continue;

    const next = rendered[index + 1];
    expect(next?.role).toBe("user");
    expect(Array.isArray(next?.content)).toBe(true);

    const answered = (next!.content as Anthropic.ContentBlockParam[])
      .filter((block) => block.type === "tool_result")
      .map((block) => (block as Anthropic.ToolResultBlockParam).tool_use_id);

    expect(answered).toEqual(calls.map((call) => (call as Anthropic.ToolUseBlockParam).id));
  }

  // The mirror of the rule above: a result can only appear as an answer.
  for (const [index, message] of rendered.entries()) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    if (!message.content.some((block) => block.type === "tool_result")) continue;

    const previous = rendered[index - 1];
    expect(previous?.role).toBe("assistant");
  }

  // Empty content is rejected, whether it is a bare string or a block list.
  for (const message of rendered) {
    if (typeof message.content === "string") {
      expect(message.content.length).toBeGreaterThan(0);
    } else {
      expect(message.content.length).toBeGreaterThan(0);
    }
  }
}

/** A turn shaped like the loop builds one: a batch of calls, then their results. */
function turn(step: number, calls: number): Message[] {
  const batchId = `batch-${step}`;
  const messages: Message[] = [];

  for (let call = 0; call < calls; call++) {
    const toolCallId = `toolu_${step}_${call}`;
    // The loop pushes each call and its result as a pair, so they interleave
    // rather than arriving as one block of calls followed by one of results.
    messages.push({
      role: "assistant_tool_call",
      toolName: "read_file",
      toolCallId,
      arguments: { path: `file-${step}-${call}.ts` },
      batchId,
    });
    messages.push({
      role: "tool",
      toolName: "read_file",
      toolCallId,
      content: `contents of file-${step}-${call}.ts`,
    });
  }

  return messages;
}

describe("a rendered request is well formed", () => {
  test("a long agentic turn, batched and interleaved", () => {
    const history: Message[] = [{ role: "user", content: "refactor the parser" }];
    for (let step = 0; step < 12; step++) history.push(...turn(step, step % 3 === 0 ? 3 : 1));
    history.push({ role: "assistant", content: "Done." });

    assertWellFormed(buildAnthropicMessages(history));
  });

  /**
   * The loop injects user messages mid-turn — the iteration-budget warning, the
   * verification reminder, the continue-after-truncation prompt. Each one is a
   * place `recentMessages` can later cut the history, so each is a chance to
   * separate a call from its result.
   */
  test("survives the windowing at every cut the loop can make", () => {
    const history: Message[] = [{ role: "user", content: "refactor the parser" }];

    for (let step = 0; step < 10; step++) {
      history.push(...turn(step, step % 2 === 0 ? 2 : 1));
      if (step % 3 === 0) {
        history.push({
          role: "user",
          content: "Only 5 more steps are available before this turn is stopped.",
        });
      }
    }

    // Every window the loop could send, not just the one it happens to use.
    for (let maxTurns = 1; maxTurns <= 8; maxTurns++) {
      const windowed = recentMessages(history, maxTurns);
      if (windowed.length === 0) continue;

      assertWellFormed(buildAnthropicMessages(windowed));
    }
  });

  /**
   * The one shape that cannot be rendered as a tool result — the call is gone —
   * still has to produce a valid request rather than a 400.
   */
  test("a result whose call was cut away is still a legal request", () => {
    const orphaned: Message[] = [
      { role: "user", content: "continue" },
      { role: "tool", toolName: "read_file", toolCallId: "toolu_gone", content: "contents" },
      { role: "user", content: "what did it say?" },
    ];

    const rendered = buildAnthropicMessages(orphaned);

    assertWellFormed(rendered);
    // Reported, not silently dropped: the model still learns what the tool said.
    expect(JSON.stringify(rendered)).toContain("contents");
  });
});
