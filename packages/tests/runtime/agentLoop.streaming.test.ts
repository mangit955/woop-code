import { describe, test, expect, beforeEach, mock } from "bun:test";
import { agentLoop } from "../../../config/runtime";
import {
  createRuntimeTest,
  getRoleSequence,
  validateConversationStructure,
} from "../shared/testHelpers";
import {
  createTextEvent,
  createDoneEvent,
  createTextStreamSequence,
} from "../shared/factories";

const mockToolRegistry = { get: () => undefined, clear: () => {} };
mock.module("../../../tools", () => ({ getTool: mock(() => undefined) }));

describe("agentLoop - Streaming", () => {
  beforeEach(() => {
    mockToolRegistry.clear();
  });

  test("accumulates text events correctly", async () => {
    const { provider, callbacks, messages } = createRuntimeTest();

    provider.setEvents([
      createTextEvent("Hello"),
      createTextEvent(" "),
      createTextEvent("world"),
      createDoneEvent(),
    ]);

    const result = await agentLoop(provider, messages, "", callbacks);

    expect(result).toBe("Hello world");
    expect(callbacks.getCallsByName("onText").length).toBe(3);
    expect(callbacks.getCallsByName("onDone").length).toBe(1);

    expect(getRoleSequence(messages)).toEqual(["user", "assistant"]);
    validateConversationStructure(messages);
  });

  test("handles empty stream gracefully", async () => {
    const { provider, callbacks, messages } = createRuntimeTest();

    provider.setEvents([createDoneEvent()]);

    const result = await agentLoop(provider, messages, "", callbacks);

    expect(result).toBe("");
    expect(callbacks.getCallsByName("onDone").length).toBe(1);

    expect(messages.length).toBe(2);
    validateConversationStructure(messages);
  });

  test("handles whitespace-only stream", async () => {
    const { provider, callbacks, messages } = createRuntimeTest();

    provider.setEvents([
      createTextEvent("   "),
      createTextEvent("\n"),
      createTextEvent("\t"),
      createDoneEvent(),
    ]);

    const result = await agentLoop(provider, messages, "", callbacks);

    expect(result).toBe("   \n\t");
    validateConversationStructure(messages);
  });

  test("handles unicode correctly", async () => {
    const { provider, callbacks, messages } = createRuntimeTest();

    provider.setEvents([
      createTextEvent("Hello 世界"),
      createTextEvent(" 🚀 "),
      createTextEvent("مرحبا"),
      createDoneEvent(),
    ]);

    const result = await agentLoop(provider, messages, "", callbacks);

    expect(result).toBe("Hello 世界 🚀 مرحبا");
    validateConversationStructure(messages);
  });

  test("handles very long text accumulation", async () => {
    const { provider, callbacks, messages } = createRuntimeTest();

    const chunks = Array(200)
      .fill(null)
      .map((_, i) => `chunk${i} `);
    provider.setEvents(createTextStreamSequence(chunks));

    const result = await agentLoop(provider, messages, "", callbacks);

    expect(result).toContain("chunk0");
    expect(result).toContain("chunk199");
    expect(callbacks.getCallsByName("onText").length).toBe(200);
    validateConversationStructure(messages);
  });

  test("onText callback receives each chunk", async () => {
    const { provider, callbacks, messages } = createRuntimeTest();

    provider.setEvents([
      createTextEvent("a"),
      createTextEvent("b"),
      createTextEvent("c"),
      createDoneEvent(),
    ]);

    await agentLoop(provider, messages, "", callbacks);

    const textCalls = callbacks.getCallsByName("onText");
    expect(textCalls.map((c) => c.args[0])).toEqual(["a", "b", "c"]);
  });

  test("done event without text still completes", async () => {
    const { provider, callbacks, messages } = createRuntimeTest();

    provider.setEvents([createDoneEvent()]);

    const result = await agentLoop(provider, messages, "", callbacks);

    expect(result).toBe("");
    expect(callbacks.getCallsByName("onDone").length).toBe(1);
    validateConversationStructure(messages);
  });

  test("newlines and special characters preserved", async () => {
    const { provider, callbacks, messages } = createRuntimeTest();

    provider.setEvents([
      createTextEvent("Line 1\n"),
      createTextEvent("Line 2\r\n"),
      createTextEvent("Tab\there"),
      createDoneEvent(),
    ]);

    const result = await agentLoop(provider, messages, "", callbacks);

    expect(result).toBe("Line 1\nLine 2\r\nTab\there");
  });
});
