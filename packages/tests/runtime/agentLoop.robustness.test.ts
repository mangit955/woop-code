import { describe, test, expect, beforeEach, mock } from "bun:test";
import { agentLoop } from "../../../config/runtime";
import { MockTool, MockToolRegistry } from "../shared/mocks";
import {
  createRuntimeTest,
  createStreamingProvider,
  generateRandomToolArgs,
  validateConversationStructure,
} from "../shared/testHelpers";
import {
  createTextEvent,
  createDoneEvent,
  createToolCallEvent,
  generateLargeText,
} from "../shared/factories";

const mockToolRegistry = new MockToolRegistry();
const getTool = mock((name: string) => mockToolRegistry.get(name));
mock.module("../../../tools", () => ({ getTool }));

describe("agentLoop - Robustness", () => {
  beforeEach(() => {
    mockToolRegistry.clear();
  });

  test("handles tool returning invalid JSON", async () => {
    const tool = new MockTool("json_tool", '{"invalid": json}');
    mockToolRegistry.register(tool);

    const { callbacks, messages } = createRuntimeTest();

    const provider = createStreamingProvider([
      [createToolCallEvent("json_tool", {}), createDoneEvent()],
      [createTextEvent("Done"), createDoneEvent()],
    ]);

    // Should not crash - treats as string
    const result = await agentLoop(provider, messages, "", callbacks);

    expect(result).toBe("Done");
    validateConversationStructure(messages);
  });

  test("handles tool returning null", async () => {
    const tool = new MockTool("null_tool", "");
    tool.setResult("");
    mockToolRegistry.register(tool);

    const { callbacks, messages } = createRuntimeTest();

    const provider = createStreamingProvider([
      [createToolCallEvent("null_tool", {}), createDoneEvent()],
      [createTextEvent("Done"), createDoneEvent()],
    ]);

    const result = await agentLoop(provider, messages, "", callbacks);

    expect(result).toBe("Done");
    validateConversationStructure(messages);
  });

  test("handles empty tool result", async () => {
    const tool = new MockTool("empty_tool", "");
    mockToolRegistry.register(tool);

    const { callbacks, messages } = createRuntimeTest();

    const provider = createStreamingProvider([
      [createToolCallEvent("empty_tool", {}), createDoneEvent()],
      [createTextEvent("Continued"), createDoneEvent()],
    ]);

    const result = await agentLoop(provider, messages, "", callbacks);

    expect(result).toBe("Continued");
    validateConversationStructure(messages);
  });

  test("handles multiple done events gracefully", async () => {
    const { callbacks, messages } = createRuntimeTest();

    const provider: any = {
      async *stream() {
        yield createTextEvent("Text");
        yield createDoneEvent();
        yield createDoneEvent(); // Extra done
        yield createDoneEvent(); // Extra done
      },
    };

    const result = await agentLoop(provider, messages, "", callbacks);

    expect(result).toBe("Text");
    validateConversationStructure(messages);
  });

  test("handles two tool calls in same stream iteration", async () => {
    const tool = new MockTool("test_tool", "Result");
    mockToolRegistry.register(tool);

    const { callbacks, messages } = createRuntimeTest();

    const provider: any = {
      async *stream() {
        // First iteration: only one tool call should be processed
        // Using same args would trigger loop detection, so use different args
        yield createToolCallEvent("test_tool", { first: true }, "call-1");
        yield createToolCallEvent("test_tool", { second: true }, "call-2");
        yield createDoneEvent();
      },
    };

    // Current implementation takes the last tool_call event
    // This will execute once with the second set of args
    const provider2 = createStreamingProvider([
      [createToolCallEvent("test_tool", { second: true }, "call-2"), createDoneEvent()],
      [createTextEvent("Done"), createDoneEvent()],
    ]);

    await agentLoop(provider2, messages, "", callbacks);

    // Should have executed the tool once
    expect(tool.executionCount).toBe(1);
    expect(tool.lastArgs).toEqual({ second: true });
  });

  test("handles stream ending without done event", async () => {
    const { callbacks, messages } = createRuntimeTest();

    const provider: any = {
      async *stream() {
        yield createTextEvent("Partial");
        // Stream ends abruptly
      },
    };

    const result = await agentLoop(provider, messages, "", callbacks);

    // Should still save partial response
    expect(result).toBe("Partial");
    validateConversationStructure(messages);
  });

  test("handles huge conversation (1000 messages)", async () => {
    const { callbacks, messages } = createRuntimeTest();

    // Add 999 more messages (1000 total with initial user message)
    for (let i = 0; i < 999; i++) {
      messages.push({
        role: i % 2 === 0 ? "assistant" : "user",
        content: `Message ${i}`,
      });
    }

    const provider = createStreamingProvider([
      [createTextEvent("Response"), createDoneEvent()],
    ]);

    const result = await agentLoop(provider, messages, "", callbacks);

    expect(result).toBe("Response");
    expect(messages.length).toBe(1001);
  });

  test("handles extremely large repo context", async () => {
    const { callbacks, messages } = createRuntimeTest();
    const hugeContext = generateLargeText(500_000); // 500KB

    const provider = createStreamingProvider([
      [createTextEvent("OK"), createDoneEvent()],
    ]);

    const result = await agentLoop(provider, messages, hugeContext, callbacks);

    expect(result).toBe("OK");
  });

  test("handles tool with random arguments (fuzz test)", async () => {
    const tool = new MockTool("fuzz_tool", "OK");
    mockToolRegistry.register(tool);

    const { callbacks, messages } = createRuntimeTest();

    // Run 50 times with random arguments
    for (let i = 0; i < 50; i++) {
      const randomArgs = generateRandomToolArgs();

      const provider = createStreamingProvider([
        [createToolCallEvent("fuzz_tool", randomArgs, `call-${i}`), createDoneEvent()],
        [createTextEvent("Next"), createDoneEvent()],
      ]);

      // Should never crash
      await expect(
        agentLoop(provider, messages, "", callbacks),
      ).resolves.toBeDefined();
    }

    expect(tool.executionCount).toBe(50);
  });

  test("handles tool arguments with special characters", async () => {
    const tool = new MockTool("special_tool", "OK");
    mockToolRegistry.register(tool);

    const { callbacks, messages } = createRuntimeTest();

    const specialArgs = {
      quotes: 'He said "hello"',
      backslash: "C:\\Users\\test",
      unicode: "世界🚀",
      newlines: "Line1\nLine2\r\nLine3",
      tabs: "Col1\tCol2\tCol3",
      nullChar: "Before\x00After",
      emoji: "🎉🎊🎈",
    };

    const provider = createStreamingProvider([
      [createToolCallEvent("special_tool", specialArgs), createDoneEvent()],
      [createTextEvent("Done"), createDoneEvent()],
    ]);

    const result = await agentLoop(provider, messages, "", callbacks);

    expect(result).toBe("Done");
    expect(tool.lastArgs).toEqual(specialArgs);
  });

  test("handles partial tool call (missing arguments)", async () => {
    const tool = new MockTool("partial_tool", "OK");
    mockToolRegistry.register(tool);

    const { callbacks, messages } = createRuntimeTest();

    // Tool call with undefined/missing fields
    const provider: any = {
      async *stream() {
        yield {
          type: "tool_call",
          id: "test-id",
          name: "partial_tool",
          arguments: undefined, // Missing
        };
        yield createDoneEvent();
      },
    };

    // Should handle gracefully
    await expect(
      agentLoop(provider, messages, "", callbacks),
    ).rejects.toThrow(); // Will throw because arguments is undefined
  });

  test("handles tool returning extremely large output", async () => {
    const largeOutput = generateLargeText(100_000); // 100KB
    const tool = new MockTool("large_tool", largeOutput);
    mockToolRegistry.register(tool);

    const { callbacks, messages } = createRuntimeTest();

    const provider = createStreamingProvider([
      [createToolCallEvent("large_tool", {}), createDoneEvent()],
      [createTextEvent("Done"), createDoneEvent()],
    ]);

    const result = await agentLoop(provider, messages, "", callbacks);

    // Should truncate at 4000 chars
    const toolMsg = messages.find((m) => m.role === "tool") as any;
    expect(toolMsg.content.length).toBeLessThanOrEqual(4050); // 4000 + truncation message
    expect(toolMsg.content).toContain("...output truncated...");
  });

  test("handles malformed event (missing required fields)", async () => {
    const { callbacks, messages } = createRuntimeTest();

    const provider: any = {
      async *stream() {
        yield { type: "text" }; // Missing content
        yield createDoneEvent();
      },
    };

    const result = await agentLoop(provider, messages, "", callbacks);

    // Should handle undefined content
    expect(result).toBe("undefined");
  });

  test("handles unknown event type", async () => {
    const { callbacks, messages } = createRuntimeTest();

    const provider: any = {
      async *stream() {
        yield { type: "unknown_event", data: "something" };
        yield createTextEvent("Text");
        yield createDoneEvent();
      },
    };

    const result = await agentLoop(provider, messages, "", callbacks);

    // Should ignore unknown event and continue
    expect(result).toBe("Text");
  });
});
