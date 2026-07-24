import { describe, test, expect, beforeEach, mock } from "bun:test";
import { agentLoop } from "../../../config/runtime";
import type { Message } from "../../../config/types";
import { MockTool, MockToolRegistry } from "../shared/mocks";
import {
  createRuntimeTest,
  createStreamingProvider,
  validateConversationStructure,
  assertMessagesOnlyGrow,
  assertNoDuplicateToolCallIds,
  assertToolCallsHaveResults,
  assertValidConversationEnd,
  getRoleSequence,
} from "../shared/testHelpers";
import {
  createTextEvent,
  createDoneEvent,
  createToolCallEvent,
} from "../shared/factories";
import { clone } from "../shared/helpers";

const mockToolRegistry = new MockToolRegistry();
const getTool = mock((name: string) => mockToolRegistry.get(name));
mock.module("../../../tools", () => ({ getTool }));

describe("agentLoop - Invariants", () => {
  beforeEach(() => {
    mockToolRegistry.clear();
  });

  test("INVARIANT: messages array only grows", async () => {
    const { callbacks, messages } = createRuntimeTest();
    const originalLength = messages.length;
    const originalMessages = clone(messages);

    const provider = createStreamingProvider([
      [createTextEvent("Response"), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    assertMessagesOnlyGrow(originalMessages, messages);
    expect(messages.length).toBeGreaterThan(originalLength);
  });

  test("INVARIANT: conversation structure is always valid", async () => {
    const tool = new MockTool("test_tool", "Result");
    mockToolRegistry.register(tool);

    const { callbacks, messages } = createRuntimeTest();

    const provider = createStreamingProvider([
      [createToolCallEvent("test_tool", {}), createDoneEvent()],
      [createTextEvent("Done"), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    // Should not throw
    validateConversationStructure(messages);
  });

  test("INVARIANT: no duplicate tool call IDs", async () => {
    const tool = new MockTool("test_tool", "Result");
    mockToolRegistry.register(tool);

    const { callbacks, messages } = createRuntimeTest();

    const provider = createStreamingProvider([
      [createToolCallEvent("test_tool", { a: 1 }, "call-1"), createDoneEvent()],
      [createToolCallEvent("test_tool", { a: 2 }, "call-2"), createDoneEvent()],
      [createTextEvent("Done"), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    // Should not throw
    assertNoDuplicateToolCallIds(messages);

    // Verify we have 2 different tool calls
    const toolCalls = messages.filter((m) => m.role === "assistant_tool_call");
    expect(toolCalls.length).toBe(2);
  });

  test("INVARIANT: every tool call has a result", async () => {
    const tool = new MockTool("test_tool", "Result");
    mockToolRegistry.register(tool);

    const { callbacks, messages } = createRuntimeTest();

    const provider = createStreamingProvider([
      [createToolCallEvent("test_tool", {}), createDoneEvent()],
      [createTextEvent("Done"), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    // Should not throw
    assertToolCallsHaveResults(messages);
  });

  test("INVARIANT: conversation ends with valid message type", async () => {
    const { callbacks, messages } = createRuntimeTest();

    const provider = createStreamingProvider([
      [createTextEvent("Response"), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    // Should not throw
    assertValidConversationEnd(messages);

    const lastMsg = messages[messages.length - 1]!;
    expect(lastMsg.role).toBe("assistant");
  });

  test("INVARIANT: tool results match tool calls", async () => {
    const tool = new MockTool("test_tool", "Result");
    mockToolRegistry.register(tool);

    const { callbacks, messages } = createRuntimeTest();

    const provider = createStreamingProvider([
      [createToolCallEvent("test_tool", {}, "call-123"), createDoneEvent()],
      [createTextEvent("Done"), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    const toolCall = messages.find(
      (m) => m.role === "assistant_tool_call",
    ) as any;
    const toolResult = messages.find((m) => m.role === "tool") as any;

    expect(toolCall.toolCallId).toBe(toolResult.toolCallId);
    expect(toolCall.toolName).toBe(toolResult.toolName);
  });

  test("INVARIANT: no assistant messages with empty content", async () => {
    const { callbacks, messages } = createRuntimeTest();

    const provider = createStreamingProvider([
      [createTextEvent("Non-empty"), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    const assistantMessages = messages.filter((m) => m.role === "assistant");
    for (const msg of assistantMessages) {
      const content = (msg as Extract<Message, { role: "assistant" }>).content;
      expect(content).toBeTruthy();
    }
  });

  test("INVARIANT: role sequence follows valid patterns", async () => {
    const tool = new MockTool("test_tool", "Result");
    mockToolRegistry.register(tool);

    const { callbacks, messages } = createRuntimeTest();

    const provider = createStreamingProvider([
      [createToolCallEvent("test_tool", {}), createDoneEvent()],
      [createTextEvent("Done"), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    const roles = getRoleSequence(messages);

    // Valid patterns:
    // user -> assistant
    // user -> assistant_tool_call -> tool -> assistant
    expect(roles[0]).toBe("user");
    expect(roles[roles.length - 1]).toBe("assistant");

    // No consecutive duplicates except user
    for (let i = 1; i < roles.length; i++) {
      if (roles[i] === roles[i - 1] && roles[i] !== "user") {
        throw new Error(`Invalid duplicate role: ${roles[i]} at index ${i}`);
      }
    }
  });

  test("INVARIANT: messages array never mutates existing entries", async () => {
    const { callbacks, messages } = createRuntimeTest();
    const userMessage = messages[0]!;
    const userMessageCopy = JSON.stringify(userMessage);

    const provider = createStreamingProvider([
      [createTextEvent("Response"), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    // Original user message should be unchanged
    expect(JSON.stringify(messages[0])).toBe(userMessageCopy);
  });

  test("INVARIANT: successful execution always calls onDone", async () => {
    const { callbacks, messages } = createRuntimeTest();

    const provider = createStreamingProvider([
      [createTextEvent("Response"), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    expect(callbacks.getCallsByName("onDone").length).toBe(1);
  });

  test("INVARIANT: failed execution never calls onDone", async () => {
    const { callbacks, messages } = createRuntimeTest();

    const errorProvider: any = {
      async *stream() {
        throw new Error("Provider failed");
      },
    };

    await expect(
      agentLoop(errorProvider, messages, "", callbacks),
    ).rejects.toThrow();

    expect(callbacks.getCallsByName("onDone").length).toBe(0);
    expect(callbacks.getCallsByName("onError").length).toBe(1);
  });
});
