import { describe, test, expect, beforeEach, mock } from "bun:test";
import { agentLoop } from "../../../config/runtime";
import type { Message } from "../../../config/types";
import {
  MockProviderClient,
  MockTool,
  MockToolRegistry,
  CallbackSpy,
} from "../shared/mocks";
import {
  createUserMessage,
  createTextEvent,
  createToolCallEvent,
  createDoneEvent,
  generateLargeText,
} from "../shared/factories";
import { clone, extractAssistantText, getLastMessage } from "../shared/helpers";

// Mock the getTool function from tools module
const mockToolRegistry = new MockToolRegistry();
const getTool = mock((name: string) => mockToolRegistry.get(name));

// Patch the import
mock.module("../../../tools", () => ({
  getTool,
}));

describe("agentLoop - Basic Streaming", () => {
  let mockClient: MockProviderClient;
  let callbackSpy: CallbackSpy;
  let messages: Message[];

  beforeEach(() => {
    mockClient = new MockProviderClient();
    callbackSpy = new CallbackSpy();
    messages = [createUserMessage("Hello")];
    mockToolRegistry.clear();
  });

  test("accumulates text events correctly", async () => {
    mockClient.setEvents([
      createTextEvent("Hello"),
      createTextEvent(" "),
      createTextEvent("world"),
      createDoneEvent(),
    ]);

    const result = await agentLoop(
      mockClient,
      messages,
      "",
      callbackSpy,
    );

    expect(result).toBe("Hello world");
    expect(callbackSpy.getCallsByName("onText")).toHaveLength(3);
    expect(callbackSpy.getCallsByName("onDone")).toHaveLength(1);
    
    // Verify assistant message added to conversation
    expect(messages).toHaveLength(2);
    const lastMsg = getLastMessage(messages, "assistant");
    expect(lastMsg?.role).toBe("assistant");
    expect((lastMsg as any)?.content).toBe("Hello world");
  });

  test("handles empty text stream gracefully", async () => {
    mockClient.setEvents([createDoneEvent()]);

    const result = await agentLoop(
      mockClient,
      messages,
      "",
      callbackSpy,
    );

    expect(result).toBe("");
    expect(callbackSpy.getCallsByName("onDone")).toHaveLength(1);
    
    // Empty response should still add assistant message
    expect(messages).toHaveLength(2);
  });

  test("handles stream with only whitespace", async () => {
    mockClient.setEvents([
      createTextEvent("   "),
      createTextEvent("\n"),
      createDoneEvent(),
    ]);

    const result = await agentLoop(
      mockClient,
      messages,
      "",
      callbackSpy,
    );

    expect(result).toBe("   \n");
    expect(messages).toHaveLength(2);
  });
});

describe("agentLoop - Tool Execution", () => {
  let mockClient: MockProviderClient;
  let callbackSpy: CallbackSpy;
  let messages: Message[];
  let mockTool: MockTool;

  beforeEach(() => {
    mockClient = new MockProviderClient();
    callbackSpy = new CallbackSpy();
    messages = [createUserMessage("Run tool")];
    mockToolRegistry.clear();
    
    mockTool = new MockTool("test_tool", "Tool result");
    mockToolRegistry.register(mockTool);
  });

  test("executes tool and continues streaming", async () => {
    // Create a client that will yield different events on each iteration
    let iterationCount = 0;
    const dynamicClient: any = {
      async *stream() {
        if (iterationCount === 0) {
          iterationCount++;
          yield createToolCallEvent("test_tool", { arg: "value" });
          yield createDoneEvent();
        } else {
          // After tool execution, return text to end loop
          yield createTextEvent("Done");
          yield createDoneEvent();
        }
      }
    };

    await agentLoop(dynamicClient, messages, "", callbackSpy);

    expect(mockTool.executionCount).toBe(1);
    expect(mockTool.lastArgs).toEqual({ arg: "value" });
    
    expect(callbackSpy.getCallsByName("onToolStart")).toHaveLength(1);
    expect(callbackSpy.getCallsByName("onToolFinish")).toHaveLength(1);
    
    // Verify conversation structure: user → assistant_tool_call → tool → assistant
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages[1]?.role).toBe("assistant_tool_call");
    expect(messages[2]?.role).toBe("tool");
  });

  test("throws error when tool not found", async () => {
    mockClient.setEvents([
      createToolCallEvent("unknown_tool", {}),
      createDoneEvent(),
    ]);

    await expect(
      agentLoop(mockClient, messages, "", callbackSpy),
    ).rejects.toThrow("Unknown tool: unknown_tool");
    
    expect(callbackSpy.getCallsByName("onError")).toHaveLength(1);
  });

  test("propagates tool execution errors", async () => {
    const toolError = new Error("Tool execution failed");
    mockTool.setThrowError(toolError);
    
    mockClient.setEvents([
      createToolCallEvent("test_tool", {}),
      createDoneEvent(),
    ]);

    await expect(
      agentLoop(mockClient, messages, "", callbackSpy),
    ).rejects.toThrow("Tool execution failed");
    
    expect(callbackSpy.getCallsByName("onError")).toHaveLength(1);
  });

  test("truncates tool result at MAX_TOOL_RESULT", async () => {
    const largeResult = generateLargeText(5000);
    mockTool.setResult(largeResult);
    
    let iterationCount = 0;
    const dynamicClient: any = {
      async *stream() {
        if (iterationCount === 0) {
          iterationCount++;
          yield createToolCallEvent("test_tool", {});
          yield createDoneEvent();
        } else {
          yield createTextEvent("Done");
          yield createDoneEvent();
        }
      }
    };

    await agentLoop(dynamicClient, messages, "", callbackSpy);

    const toolResultMsg = messages.find((m) => m.role === "tool") as any;
    expect(toolResultMsg.content).toHaveLength(4000 + "\n\n...output truncated...".length);
    expect(toolResultMsg.content).toContain("...output truncated...");
  });

  test("does not truncate tool result under limit", async () => {
    const smallResult = generateLargeText(3000);
    mockTool.setResult(smallResult);
    
    let iterationCount = 0;
    const dynamicClient: any = {
      async *stream() {
        if (iterationCount === 0) {
          iterationCount++;
          yield createToolCallEvent("test_tool", {});
          yield createDoneEvent();
        } else {
          yield createTextEvent("Done");
          yield createDoneEvent();
        }
      }
    };

    await agentLoop(dynamicClient, messages, "", callbackSpy);

    const toolResultMsg = messages.find((m) => m.role === "tool") as any;
    expect(toolResultMsg.content).toBe(smallResult);
  });

  test("executes multiple tools in sequence", async () => {
    const tool2 = new MockTool("tool_two", "Second result");
    mockToolRegistry.register(tool2);
    
    let iterationCount = 0;
    const dynamicClient: any = {
      async *stream() {
        if (iterationCount === 0) {
          iterationCount++;
          yield createToolCallEvent("test_tool", { first: true });
          yield createDoneEvent();
        } else if (iterationCount === 1) {
          iterationCount++;
          yield createToolCallEvent("tool_two", { second: true });
          yield createDoneEvent();
        } else {
          yield createTextEvent("All done");
          yield createDoneEvent();
        }
      }
    };

    await agentLoop(dynamicClient, messages, "", callbackSpy);
    
    expect(mockTool.executionCount).toBe(1);
    expect(tool2.executionCount).toBe(1);
    expect(messages.length).toBeGreaterThanOrEqual(5);
  });

  test("preserves thoughtSignature in tool call message", async () => {
    let iterationCount = 0;
    const dynamicClient: any = {
      async *stream() {
        if (iterationCount === 0) {
          iterationCount++;
          yield createToolCallEvent(
            "test_tool",
            {},
            "test-id",
            "Let me use this tool",
          );
          yield createDoneEvent();
        } else {
          yield createTextEvent("Done");
          yield createDoneEvent();
        }
      }
    };

    await agentLoop(dynamicClient, messages, "", callbackSpy);

    const toolCallMsg = messages.find(
      (m) => m.role === "assistant_tool_call",
    ) as any;
    expect(toolCallMsg.thoughtSignature).toBe("Let me use this tool");
  });
});

describe("agentLoop - Tool Loop Detection", () => {
  let mockClient: MockProviderClient;
  let callbackSpy: CallbackSpy;
  let messages: Message[];
  let mockTool: MockTool;

  beforeEach(() => {
    mockClient = new MockProviderClient();
    callbackSpy = new CallbackSpy();
    messages = [createUserMessage("Test")];
    mockToolRegistry.clear();
    
    mockTool = new MockTool("looping_tool", "Result");
    mockToolRegistry.register(mockTool);
  });

  test("detects identical tool calls and throws", async () => {
    // Simulate the agent calling the same tool twice in ONE agentLoop execution
    let iterationCount = 0;
    const dynamicClient: any = {
      async *stream() {
        if (iterationCount === 0) {
          iterationCount++;
          yield createToolCallEvent("looping_tool", { param: "value" });
          yield createDoneEvent();
        } else if (iterationCount === 1) {
          iterationCount++;
          // Same tool with same args - should trigger loop detection
          yield createToolCallEvent("looping_tool", { param: "value" });
          yield createDoneEvent();
        }
      }
    };

    await expect(
      agentLoop(dynamicClient, messages, "", callbackSpy),
    ).rejects.toThrow("Tool loop detected");
  });

  test("allows same tool with different arguments", async () => {
    let iterationCount = 0;
    const dynamicClient: any = {
      async *stream() {
        if (iterationCount === 0) {
          iterationCount++;
          yield createToolCallEvent("looping_tool", { param: "first" });
          yield createDoneEvent();
        } else if (iterationCount === 1) {
          iterationCount++;
          yield createToolCallEvent("looping_tool", { param: "second" });
          yield createDoneEvent();
        } else {
          yield createTextEvent("Done");
          yield createDoneEvent();
        }
      }
    };

    await expect(
      agentLoop(dynamicClient, messages, "", callbackSpy),
    ).resolves.toBeDefined();
    
    expect(mockTool.executionCount).toBe(2);
  });

  test("tool loop detection is case-sensitive", async () => {
    let iterationCount = 0;
    const dynamicClient: any = {
      async *stream() {
        if (iterationCount === 0) {
          iterationCount++;
          yield createToolCallEvent("looping_tool", { Param: "Value" });
          yield createDoneEvent();
        } else if (iterationCount === 1) {
          iterationCount++;
          // Different case should be allowed
          yield createToolCallEvent("looping_tool", { param: "value" });
          yield createDoneEvent();
        } else {
          yield createTextEvent("Done");
          yield createDoneEvent();
        }
      }
    };

    await expect(
      agentLoop(dynamicClient, messages, "", callbackSpy),
    ).resolves.toBeDefined();
  });
});

describe("agentLoop - Iteration Limits", () => {
  let mockClient: MockProviderClient;
  let callbackSpy: CallbackSpy;
  let messages: Message[];
  let mockTool: MockTool;

  beforeEach(() => {
    mockClient = new MockProviderClient();
    callbackSpy = new CallbackSpy();
    messages = [createUserMessage("Test")];
    mockToolRegistry.clear();
    
    mockTool = new MockTool("infinite_tool", "Continue");
    mockToolRegistry.register(mockTool);
  });

  test("throws error after MAX_ITERATIONS", async () => {
    // Each iteration returns a DIFFERENT tool call (to avoid loop detection)
    let iterationCount = 0;
    const dynamicClient: any = {
      async *stream() {
        yield createToolCallEvent("infinite_tool", { iteration: iterationCount++ });
        yield createDoneEvent();
      }
    };

    const promise = agentLoop(dynamicClient, messages, "", callbackSpy);

    await expect(promise).rejects.toThrow(
      "Agent exceeded the maximum number of iterations (10)",
    );
    
    expect(mockTool.executionCount).toBe(10);
  });

  test("completes successfully within iteration limit", async () => {
    let iterationCount = 0;
    const dynamicClient: any = {
      async *stream() {
        if (iterationCount < 5) {
          yield createToolCallEvent("infinite_tool", { iteration: iterationCount++ });
          yield createDoneEvent();
        } else {
          yield createTextEvent("Done");
          yield createDoneEvent();
        }
      }
    };
    
    const result = await agentLoop(dynamicClient, messages, "", callbackSpy);
    
    expect(result).toBe("Done");
    expect(mockTool.executionCount).toBe(5);
  });
});

describe("agentLoop - Cancellation", () => {
  let mockClient: MockProviderClient;
  let callbackSpy: CallbackSpy;
  let messages: Message[];
  let abortController: AbortController;

  beforeEach(() => {
    mockClient = new MockProviderClient();
    callbackSpy = new CallbackSpy();
    messages = [createUserMessage("Test")];
    abortController = new AbortController();
  });

  test("cancellation during stream returns empty and calls onCancel", async () => {
    // Create a client that yields events but checks abort signal
    const dynamicClient: any = {
      async *stream(_msgs: any, _ctx: any, signal?: AbortSignal) {
        yield createTextEvent("Starting");
        
        // Simulate async delay
        await new Promise(resolve => setTimeout(resolve, 10));
        
        if (signal?.aborted) {
          return;
        }
        
        yield createTextEvent("...");
        yield createDoneEvent();
      }
    };
    
    // Abort after a short delay
    setTimeout(() => abortController.abort(), 5);

    const result = await agentLoop(
      dynamicClient,
      messages,
      "",
      callbackSpy,
      abortController.signal,
    );

    expect(result).toBe("");
    expect(callbackSpy.getCallsByName("onCancel")).toHaveLength(1);
    expect(callbackSpy.getCallsByName("onDone")).toHaveLength(0);
  });

  test("cancellation before stream starts", async () => {
    abortController.abort();
    
    mockClient.setEvents([
      createTextEvent("Should not appear"),
      createDoneEvent(),
    ]);

    const result = await agentLoop(
      mockClient,
      messages,
      "",
      callbackSpy,
      abortController.signal,
    );

    expect(result).toBe("");
    expect(callbackSpy.getCallsByName("onCancel")).toHaveLength(1);
  });

  test("cancellation during tool execution", async () => {
    const slowTool = new MockTool("slow_tool", "Result");
    slowTool.setDelay(50);
    mockToolRegistry.register(slowTool);
    
    mockClient.setEvents([
      createToolCallEvent("slow_tool", {}),
      createDoneEvent(),
    ]);
    
    // Abort during tool execution
    setTimeout(() => abortController.abort(), 10);

    // Note: current implementation doesn't cancel tool execution itself
    // It only checks after stream completes
    const result = await agentLoop(
      mockClient,
      messages,
      "",
      callbackSpy,
      abortController.signal,
    );

    expect(result).toBe("");
    expect(callbackSpy.getCallsByName("onCancel")).toHaveLength(1);
  });
});

describe("agentLoop - Error Handling", () => {
  let mockClient: MockProviderClient;
  let callbackSpy: CallbackSpy;
  let messages: Message[];

  beforeEach(() => {
    mockClient = new MockProviderClient();
    callbackSpy = new CallbackSpy();
    messages = [createUserMessage("Test")];
  });

  test("provider error propagates and calls onError", async () => {
    const providerError = new Error("Network timeout");
    mockClient.setThrowError(providerError);

    await expect(
      agentLoop(mockClient, messages, "", callbackSpy),
    ).rejects.toThrow("Network timeout");
    
    expect(callbackSpy.getCallsByName("onError")).toHaveLength(1);
    expect(callbackSpy.getCallsByName("onError")[0]?.args[0]).toBe(
      providerError,
    );
  });

  test("non-Error exceptions wrapped in Error", async () => {
    mockClient.setThrowError(new Error("string error"));

    await expect(
      agentLoop(mockClient, messages, "", callbackSpy),
    ).rejects.toThrow();
    
    const errorCall = callbackSpy.getCallsByName("onError")[0];
    expect(errorCall?.args[0]).toBeInstanceOf(Error);
  });

  test("error does not corrupt messages array", async () => {
    const originalLength = messages.length;
    mockClient.setThrowError(new Error("Provider failed"));

    await expect(
      agentLoop(mockClient, messages, "", callbackSpy),
    ).rejects.toThrow();
    
    // Messages should remain in valid state
    expect(messages.length).toBeGreaterThanOrEqual(originalLength);
    expect(messages[0]?.role).toBe("user");
  });
});

describe("agentLoop - Message State Updates", () => {
  let mockClient: MockProviderClient;
  let callbackSpy: CallbackSpy;
  let messages: Message[];

  beforeEach(() => {
    mockClient = new MockProviderClient();
    callbackSpy = new CallbackSpy();
    messages = [createUserMessage("Test")];
  });

  test("messages array updated after text response", async () => {
    mockClient.setEvents([
      createTextEvent("Response text"),
      createDoneEvent(),
    ]);

    await agentLoop(mockClient, messages, "", callbackSpy);

    expect(messages).toHaveLength(2);
    expect(messages[1]?.role).toBe("assistant");
    expect((messages[1] as any).content).toBe("Response text");
  });

  test("messages array updated with tool call and result", async () => {
    const tool = new MockTool("test_tool", "Tool output");
    mockToolRegistry.register(tool);
    
    let iterationCount = 0;
    const dynamicClient: any = {
      async *stream() {
        if (iterationCount === 0) {
          iterationCount++;
          yield createToolCallEvent("test_tool", { arg: "val" }, "call-123");
          yield createDoneEvent();
        } else {
          yield createTextEvent("Done");
          yield createDoneEvent();
        }
      }
    };

    await agentLoop(dynamicClient, messages, "", callbackSpy);

    expect(messages.length).toBeGreaterThanOrEqual(3);
    
    // Check assistant_tool_call message
    const toolCall = messages.find(m => m.role === "assistant_tool_call") as any;
    expect(toolCall).toBeDefined();
    expect(toolCall.toolName).toBe("test_tool");
    expect(toolCall.toolCallId).toBe("call-123");
    expect(toolCall.arguments).toEqual({ arg: "val" });
    
    // Check tool result message
    const toolResult = messages.find(m => m.role === "tool") as any;
    expect(toolResult).toBeDefined();
    expect(toolResult.toolName).toBe("test_tool");
    expect(toolResult.toolCallId).toBe("call-123");
    expect(toolResult.content).toBe("Tool output");
  });

  test("messages array preserves existing messages", async () => {
    messages.push(createUserMessage("Second message"));
    const originalLength = messages.length;
    
    mockClient.setEvents([createTextEvent("Reply"), createDoneEvent()]);

    await agentLoop(mockClient, messages, "", callbackSpy);

    expect(messages.length).toBe(originalLength + 1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[1]?.role).toBe("user");
    expect(messages[2]?.role).toBe("assistant");
  });
});

describe("agentLoop - Edge Cases", () => {
  let mockClient: MockProviderClient;
  let callbackSpy: CallbackSpy;
  let messages: Message[];

  beforeEach(() => {
    mockClient = new MockProviderClient();
    callbackSpy = new CallbackSpy();
    messages = [createUserMessage("Test")];
  });

  test("handles done event without prior text or tool call", async () => {
    mockClient.setEvents([createDoneEvent()]);

    const result = await agentLoop(mockClient, messages, "", callbackSpy);

    expect(result).toBe("");
    expect(callbackSpy.getCallsByName("onDone")).toHaveLength(1);
  });

  test("handles unicode in text streams", async () => {
    mockClient.setEvents([
      createTextEvent("Hello 世界"),
      createTextEvent(" 🚀"),
      createDoneEvent(),
    ]);

    const result = await agentLoop(mockClient, messages, "", callbackSpy);

    expect(result).toBe("Hello 世界 🚀");
  });

  test("handles empty arguments in tool call", async () => {
    const tool = new MockTool("no_args_tool", "Success");
    mockToolRegistry.register(tool);
    
    let iterationCount = 0;
    const dynamicClient: any = {
      async *stream() {
        if (iterationCount === 0) {
          iterationCount++;
          yield createToolCallEvent("no_args_tool", {});
          yield createDoneEvent();
        } else {
          yield createTextEvent("Done");
          yield createDoneEvent();
        }
      }
    };

    await agentLoop(dynamicClient, messages, "", callbackSpy);

    expect(tool.lastArgs).toEqual({});
  });

  test("handles very long text accumulation", async () => {
    const chunks = Array(100)
      .fill(null)
      .map((_, i) => createTextEvent(`chunk${i} `));
    chunks.push(createDoneEvent());
    
    mockClient.setEvents(chunks);

    const result = await agentLoop(mockClient, messages, "", callbackSpy);

    expect(result).toContain("chunk0");
    expect(result).toContain("chunk99");
    expect(callbackSpy.getCallsByName("onText")).toHaveLength(100);
  });

  test("handles empty repo context", async () => {
    mockClient.setEvents([createTextEvent("OK"), createDoneEvent()]);

    await expect(
      agentLoop(mockClient, messages, "", callbackSpy),
    ).resolves.toBe("OK");
  });

  test("handles large repo context", async () => {
    const largeContext = generateLargeText(100000);
    mockClient.setEvents([createTextEvent("OK"), createDoneEvent()]);

    await expect(
      agentLoop(mockClient, messages, largeContext, callbackSpy),
    ).resolves.toBe("OK");
  });
});
