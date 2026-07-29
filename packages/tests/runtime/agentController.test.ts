import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { AgentController } from "../../../commands/agentController";
import type { Message } from "../../../config/types";
import {
  MockProviderClient,
  MockTool,
  MockToolRegistry,
} from "../shared/mocks";
import {
  createUserMessage,
  createTextEvent,
  createToolCallEvent,
  createDoneEvent,
} from "../shared/factories";
import { wait } from "../shared/helpers";

// Mock dependencies
const mockToolRegistry = new MockToolRegistry();
const getTool = mock((name: string) => mockToolRegistry.get(name));

mock.module("../../../tools", () => ({
  getTool,
  toolRegistery: [],
}));

// Mock config functions
let mockConversation: Message[] = [];
let mockRepoContext = "";

const getConversation = mock(async () => [...mockConversation]);
const saveConversation = mock(async (messages: Message[]) => {
  mockConversation = [...messages];
});
const buildRepositoryContext = mock(async () => mockRepoContext);

mock.module("../../../config/config", () => ({
  getConversation,
  saveConversation,
  buildRepositoryContext,
  recentMessages: (messages: Message[], maxTurns: number) => messages,
}));

// Mock provider client creation
let globalMockClient: MockProviderClient;

const createProviderClient = mock((provider: string, apiKey: string, model?: string) => {
  return globalMockClient;
});

mock.module("../../../config/client", () => ({
  createProviderClient,
}));

// Mock the UI store
const mockStore = {
  addUserMessage: mock(() => {}),
  setStatus: mock(() => {}),
  startAssistantMessage: mock(() => {}),
  appendAssistantText: mock(() => {}),
  finishAssistantMessage: mock(() => {}),
  setSelectedModel: mock(() => {}),
  startTool: mock(() => {}),
  finishTool: mock(() => {}),
  clearPendingEdit: mock(() => {}),
  clearPendingCommand: mock(() => {}),
  cancelPendingQuestion: mock(() => {}),
};

mock.module("../../../tui/src", () => ({
  store: mockStore,
}));

describe("AgentController - Basic Execution", () => {
  beforeEach(() => {
    mockConversation = [];
    mockRepoContext = "test repo";
    globalMockClient = new MockProviderClient();
    mockToolRegistry.clear();
    
    // Reset all mock call counts
    Object.values(mockStore).forEach(m => m.mockClear?.());
    getConversation.mockClear();
    saveConversation.mockClear();
    buildRepositoryContext.mockClear();
  });

  test("run executes successfully and returns response", async () => {
    globalMockClient.setEvents([
      createTextEvent("Hello world"),
      createDoneEvent(),
    ]);

    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();

    const result = await controller.run("Test prompt");

    expect(result).toBe("Hello world");
    expect(controller.isBusy()).toBe(false);
  });

  test("initialize loads conversation from disk", async () => {
    mockConversation = [
      createUserMessage("Previous message"),
      { role: "assistant", content: "Previous response" },
    ];

    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();

    // Verify conversation loaded by checking dispose saves correct length
    globalMockClient.setEvents([
      createTextEvent("New response"),
      createDoneEvent(),
    ]);
    
    await controller.run("New prompt");
    await controller.dispose();

    expect(saveConversation).toHaveBeenCalled();
    const savedMessages = saveConversation.mock.calls[0]?.[0] as Message[];
    expect(savedMessages.length).toBeGreaterThanOrEqual(4); // 2 previous + 1 user + 1 assistant
  });

  test("dispose saves conversation to disk", async () => {
    globalMockClient.setEvents([
      createTextEvent("Response"),
      createDoneEvent(),
    ]);

    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();
    await controller.run("Prompt");
    await controller.dispose();

    expect(saveConversation).toHaveBeenCalled();
    const savedMessages = saveConversation.mock.calls[saveConversation.mock.calls.length - 1]?.[0] as Message[];
    expect(savedMessages.length).toBeGreaterThanOrEqual(2); // at least user + assistant
    expect(savedMessages[savedMessages.length - 2]?.role).toBe("user");
    expect(savedMessages[savedMessages.length - 1]?.role).toBe("assistant");
  });

  test("isBusy returns true during execution", async () => {
    globalMockClient.setEvents([
      createTextEvent("Response"),
      createDoneEvent(),
    ]);
    globalMockClient.setDelay(20);

    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();

    const runPromise = controller.run("Prompt");
    
    // Check during execution
    await wait(5);
    expect(controller.isBusy()).toBe(true);

    await runPromise;
    expect(controller.isBusy()).toBe(false);
  });
});

describe("AgentController - Concurrency Control", () => {
  beforeEach(() => {
    mockConversation = [];
    globalMockClient = new MockProviderClient();
    mockToolRegistry.clear();
    getConversation.mockClear();
    saveConversation.mockClear();
    buildRepositoryContext.mockClear();
  });

  test("concurrent run calls are rejected", async () => {
    globalMockClient.setEvents([
      createTextEvent("First response"),
      createDoneEvent(),
    ]);
    globalMockClient.setDelay(50);

    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();

    const firstRun = controller.run("First prompt");
    
    // Try to run again while first is still running
    await wait(10);
    const secondRun = controller.run("Second prompt");

    const firstResult = await firstRun;
    const secondResult = await secondRun;

    // First should succeed
    expect(firstResult).toBe("First response");
    
    // Second should return undefined (rejected)
    expect(secondResult).toBeUndefined();
  });

  test("sequential run calls work correctly", async () => {
    globalMockClient.setEvents([
      createTextEvent("First"),
      createDoneEvent(),
    ]);

    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();

    const first = await controller.run("First");
    expect(first).toBe("First");

    globalMockClient.setEvents([
      createTextEvent("Second"),
      createDoneEvent(),
    ]);

    const second = await controller.run("Second");
    expect(second).toBe("Second");
  });

  test("run after cancel completes successfully", async () => {
    globalMockClient.setEvents([
      createTextEvent("First"),
      createDoneEvent(),
    ]);
    globalMockClient.setDelay(30);

    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();

    const firstRun = controller.run("First");
    await wait(10);
    controller.cancel();
    await firstRun;

    // Now run again
    globalMockClient.setEvents([
      createTextEvent("Second"),
      createDoneEvent(),
    ]);
    globalMockClient.setDelay(0);

    const second = await controller.run("Second");
    expect(second).toBe("Second");
  });
});

describe("AgentController - Cancellation", () => {
  beforeEach(() => {
    mockConversation = [];
    globalMockClient = new MockProviderClient();
    mockToolRegistry.clear();
    getConversation.mockClear();
    saveConversation.mockClear();
    buildRepositoryContext.mockClear();
  });

  test("cancel during execution stops agent loop", async () => {
    const dynamicClient: any = {
      async *stream(_msgs: any, _ctx: any, signal?: AbortSignal) {
        yield createTextEvent("Starting");
        
        await wait(20);
        
        if (signal?.aborted) {
          return;
        }
        
        yield createTextEvent(" more text");
        yield createDoneEvent();
      }
    };
    globalMockClient = dynamicClient;

    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();

    const runPromise = controller.run("Test");
    
    await wait(10);
    controller.cancel();

    const result = await runPromise;
    
    expect(result).toBe("");
    expect(controller.isBusy()).toBe(false);
    expect(mockStore.clearPendingEdit).toHaveBeenCalled();
    expect(mockStore.clearPendingCommand).toHaveBeenCalled();
    expect(mockStore.cancelPendingQuestion).toHaveBeenCalled();
  });

  test("cancel sets wasCancelled flag", async () => {
    const dynamicClient: any = {
      async *stream(_msgs: any, _ctx: any, signal?: AbortSignal) {
        await wait(20);
        if (signal?.aborted) return;
        yield createTextEvent("Text");
        yield createDoneEvent();
      }
    };
    globalMockClient = dynamicClient;

    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();

    const runPromise = controller.run("Test");
    await wait(5);
    controller.cancel();
    await runPromise;

    // Verify by checking dispose behavior
    const initialSaveCount = saveConversation.mock.calls.length;
    await controller.dispose();
    
    const savedMessages = saveConversation.mock.calls[saveConversation.mock.calls.length - 1]?.[0] as Message[];
    // After cancellation, pending user message should be removed
    // So we should see fewer user messages than expected
    const userMessages = savedMessages.filter(m => m.role === "user");
    expect(userMessages.length).toBeLessThanOrEqual(0);
  });

  test("cancel when not running does nothing", () => {
    const controller = new AgentController("google", "test-key", {});
    
    expect(() => controller.cancel()).not.toThrow();
    expect(controller.isBusy()).toBe(false);
  });

  test("pendingUserMessage removed on cancellation", async () => {
    const dynamicClient: any = {
      async *stream(_msgs: any, _ctx: any, signal?: AbortSignal) {
        await wait(20);
        if (signal?.aborted) return;
        yield createTextEvent("Text");
        yield createDoneEvent();
      }
    };
    globalMockClient = dynamicClient;

    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();

    // Get initial conversation size
    const initialSaveCount = saveConversation.mock.calls.length;

    // Run and cancel
    const runPromise = controller.run("Test prompt");
    await wait(5);
    controller.cancel();
    await runPromise;

    // Dispose and check conversation
    await controller.dispose();
    
    const savedMessages = saveConversation.mock.calls[saveConversation.mock.calls.length - 1]?.[0] as Message[];
    // The cancelled user message should have been removed
    // Check if last message is NOT the user message we just sent
    const lastUserMsg = savedMessages.filter(m => m.role === "user").pop();
    if (lastUserMsg) {
      expect((lastUserMsg as any).content).not.toBe("Test prompt");
    }
  });
});

describe("AgentController - State Management", () => {
  beforeEach(() => {
    mockConversation = [];
    globalMockClient = new MockProviderClient();
    mockToolRegistry.clear();
    getConversation.mockClear();
    saveConversation.mockClear();
    buildRepositoryContext.mockClear();
  });

  test("conversation state accumulates across runs", async () => {
    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();

    // First run
    globalMockClient.setEvents([
      createTextEvent("First response"),
      createDoneEvent(),
    ]);
    await controller.run("First prompt");

    // Second run
    globalMockClient.setEvents([
      createTextEvent("Second response"),
      createDoneEvent(),
    ]);
    await controller.run("Second prompt");

    // Dispose and verify
    await controller.dispose();
    
    const savedMessages = saveConversation.mock.calls[0]?.[0] as Message[];
    expect(savedMessages.length).toBe(4); // 2 users + 2 assistants
    expect(savedMessages[0]?.role).toBe("user");
    expect(savedMessages[1]?.role).toBe("assistant");
    expect(savedMessages[2]?.role).toBe("user");
    expect(savedMessages[3]?.role).toBe("assistant");
  });

  test("dispose with pending assistant text saves it", async () => {
    // Simulate incomplete response
    const dynamicClient: any = {
      async *stream() {
        yield createTextEvent("Partial response");
        // Never yield done - simulates interruption
      }
    };
    globalMockClient = dynamicClient;

    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();

    try {
      await controller.run("Test");
    } catch {
      // May throw, that's fine
    }

    await controller.dispose();

    const savedMessages = saveConversation.mock.calls[0]?.[0] as Message[];
    // Should save the partial assistant text
    const assistantMessages = savedMessages.filter(m => m.role === "assistant");
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
  });

  test("error during run doesn't corrupt conversation", async () => {
    const errorClient: any = {
      async *stream() {
        yield createTextEvent("Starting");
        throw new Error("Provider error");
      }
    };
    globalMockClient = errorClient;

    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();

    await expect(controller.run("Test")).rejects.toThrow("Provider error");

    // Conversation should still be valid
    await controller.dispose();
    
    const savedMessages = saveConversation.mock.calls[0]?.[0] as Message[];
    expect(savedMessages.length).toBeGreaterThanOrEqual(1);
    expect(savedMessages[0]?.role).toBe("user");
  });

  test("repo context loaded during initialize", async () => {
    mockRepoContext = "Custom repo context";

    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();

    expect(buildRepositoryContext).toHaveBeenCalled();
  });
});

describe("AgentController - Callbacks", () => {
  beforeEach(() => {
    mockConversation = [];
    globalMockClient = new MockProviderClient();
    mockToolRegistry.clear();
    getConversation.mockClear();
    saveConversation.mockClear();
    buildRepositoryContext.mockClear();
  });

  test("onText callback receives streamed text", async () => {
    const textChunks: string[] = [];
    const callbacks = {
      onText: (text: string) => textChunks.push(text),
    };

    globalMockClient.setEvents([
      createTextEvent("Hello"),
      createTextEvent(" "),
      createTextEvent("world"),
      createDoneEvent(),
    ]);

    const controller = new AgentController("google", "test-key", callbacks);
    await controller.initialize();
    await controller.run("Test");

    expect(textChunks).toEqual(["Hello", " ", "world"]);
  });

  test("onToolStart and onToolFinish called for tool execution", async () => {
    const tool = new MockTool("test_tool", "Tool result");
    mockToolRegistry.register(tool);

    const toolCalls: any[] = [];
    const callbacks = {
      onToolStart: (tool: any) => toolCalls.push({ event: "start", tool }),
      onToolFinish: (tool: any) => toolCalls.push({ event: "finish", tool }),
    };

    let iteration = 0;
    const dynamicClient: any = {
      async *stream() {
        if (iteration === 0) {
          iteration++;
          yield createToolCallEvent("test_tool", { arg: "val" });
          yield createDoneEvent();
        } else {
          yield createTextEvent("Done");
          yield createDoneEvent();
        }
      }
    };
    globalMockClient = dynamicClient;

    const controller = new AgentController("google", "test-key", callbacks);
    await controller.initialize();
    await controller.run("Test");

    expect(toolCalls.length).toBe(2);
    expect(toolCalls[0]?.event).toBe("start");
    expect(toolCalls[0]?.tool.name).toBe("test_tool");
    expect(toolCalls[1]?.event).toBe("finish");
    expect(toolCalls[1]?.tool.name).toBe("test_tool");
  });

  test("onDone callback called on successful completion", async () => {
    let doneCalled = false;
    const callbacks = {
      onDone: () => { doneCalled = true; },
    };

    globalMockClient.setEvents([
      createTextEvent("Response"),
      createDoneEvent(),
    ]);

    const controller = new AgentController("google", "test-key", callbacks);
    await controller.initialize();
    await controller.run("Test");

    expect(doneCalled).toBe(true);
  });

  test("onError callback called on provider error", async () => {
    let errorReceived: Error | null = null;
    const callbacks = {
      onError: (error: Error) => { errorReceived = error; },
    };

    const errorClient: any = {
      async *stream() {
        throw new Error("Provider failed");
      }
    };
    globalMockClient = errorClient;

    const controller = new AgentController("google", "test-key", callbacks);
    await controller.initialize();
    
    await expect(controller.run("Test")).rejects.toThrow();

    expect(errorReceived).toBeDefined();
    expect((errorReceived as Error | null)?.message).toBe("Provider failed");
  });

  test("onCancel callback called on cancellation", async () => {
    let cancelCalled = false;
    const callbacks = {
      onCancel: () => { cancelCalled = true; },
    };

    const dynamicClient: any = {
      async *stream(_msgs: any, _ctx: any, signal?: AbortSignal) {
        yield createTextEvent("Starting");
        await wait(20);
        if (signal?.aborted) return;
        yield createTextEvent("More");
        yield createDoneEvent();
      }
    };
    globalMockClient = dynamicClient;

    const controller = new AgentController("google", "test-key", callbacks);
    await controller.initialize();

    const runPromise = controller.run("Test");
    await wait(5);
    controller.cancel();
    await runPromise;

    expect(cancelCalled).toBe(true);
  });
});

describe("AgentController - Edge Cases", () => {
  beforeEach(() => {
    mockConversation = [];
    globalMockClient = new MockProviderClient();
    mockToolRegistry.clear();
    getConversation.mockClear();
    saveConversation.mockClear();
    buildRepositoryContext.mockClear();
  });

  test("handles empty prompt", async () => {
    globalMockClient.setEvents([
      createTextEvent("Response to empty"),
      createDoneEvent(),
    ]);

    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();
    const result = await controller.run("");

    expect(result).toBe("Response to empty");
  });

  test("handles unicode in prompts", async () => {
    globalMockClient.setEvents([
      createTextEvent("Response"),
      createDoneEvent(),
    ]);

    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();
    const result = await controller.run("Test 世界 🚀");

    expect(result).toBe("Response");
  });

  test("dispose without any runs works", async () => {
    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();
    
    await expect(controller.dispose()).resolves.toBeUndefined();
    
    expect(saveConversation).toHaveBeenCalled();
  });

  test("multiple dispose calls are safe", async () => {
    globalMockClient.setEvents([
      createTextEvent("Response"),
      createDoneEvent(),
    ]);

    const controller = new AgentController("google", "test-key", {});
    await controller.initialize();
    await controller.run("Test");

    await controller.dispose();
    await controller.dispose(); // Second call

    // Should not throw or cause issues
    expect(saveConversation.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("conversation isolation between instances", async () => {
    // Reset save counter
    saveConversation.mockClear();
    
    globalMockClient.setEvents([
      createTextEvent("Response 1"),
      createDoneEvent(),
    ]);

    const controller1 = new AgentController("google", "key1", {});
    await controller1.initialize();
    await controller1.run("Prompt 1");

    globalMockClient.setEvents([
      createTextEvent("Response 2"),
      createDoneEvent(),
    ]);

    const controller2 = new AgentController("google", "key2", {});
    await controller2.initialize();
    await controller2.run("Prompt 2");

    await controller1.dispose();
    await controller2.dispose();

    // Each controller should have called saveConversation at least once
    expect(saveConversation.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("AgentController - Provider switching", () => {
  beforeEach(() => {
    mockConversation = [];
    mockRepoContext = "test repo";
    globalMockClient = new MockProviderClient();
    mockToolRegistry.clear();
    createProviderClient.mockClear();
  });

  test("setProvider changes the credentials used by the next turn", async () => {
    globalMockClient.setEvents([createTextEvent("ok"), createDoneEvent()]);

    const controller = new AgentController("google", "old-key", {});
    await controller.initialize();
    await controller.run("First");

    expect(createProviderClient.mock.calls[0]?.slice(0, 2)).toEqual([
      "google",
      "old-key",
    ]);

    expect(controller.setProvider("google", "new-key")).toBe(true);
    expect(controller.getProvider()).toBe("google");

    globalMockClient.setEvents([createTextEvent("ok"), createDoneEvent()]);
    await controller.run("Second");

    expect(createProviderClient.mock.calls[1]?.slice(0, 2)).toEqual([
      "google",
      "new-key",
    ]);
  });

  test("setProvider also switches the model when one is given", async () => {
    globalMockClient.setEvents([createTextEvent("ok"), createDoneEvent()]);

    const controller = new AgentController("google", "key", "gemini-3.5-flash-lite", {});
    await controller.initialize();
    controller.setProvider("google", "key", "gemini-3.6-pro");
    await controller.run("Prompt");

    expect(createProviderClient.mock.calls[0]?.[2]).toBe("gemini-3.6-pro");
  });

  test("setProvider is refused while a turn is in flight", async () => {
    globalMockClient.setEvents([createTextEvent("streaming"), createDoneEvent()]);
    globalMockClient.setDelay(20);

    const controller = new AgentController("google", "old-key", {});
    await controller.initialize();

    const running = controller.run("Prompt");
    await wait(1);

    expect(controller.isBusy()).toBe(true);
    expect(controller.setProvider("google", "new-key")).toBe(false);

    await running;
    expect(createProviderClient.mock.calls[0]?.[1]).toBe("old-key");
  });

  test("reports a clear error instead of running without a provider", async () => {
    const errors: Error[] = [];
    const controller = new AgentController("google", "key", {
      onError: (error) => errors.push(error),
    });
    await controller.initialize();

    controller.setProvider("", "");
    await controller.run("Prompt");

    expect(createProviderClient).not.toHaveBeenCalled();
    expect(errors[0]?.message).toContain("No provider is logged in");
  });
});

describe("AgentController - Persistence", () => {
  beforeEach(() => {
    mockConversation = [];
    mockRepoContext = "test repo";
    globalMockClient = new MockProviderClient();
    mockToolRegistry.clear();
    saveConversation.mockClear();
  });

  test("saves after every turn, not only on disposal", async () => {
    const controller = new AgentController("google", "key", {});
    await controller.initialize();

    globalMockClient.setEvents([createTextEvent("first"), createDoneEvent()]);
    await controller.run("One");
    expect(saveConversation).toHaveBeenCalledTimes(1);

    globalMockClient.setEvents([createTextEvent("second"), createDoneEvent()]);
    await controller.run("Two");
    expect(saveConversation).toHaveBeenCalledTimes(2);

    // A process killed here keeps both turns.
    const saved = saveConversation.mock.calls.at(-1)?.[0] as Message[];
    expect(saved.filter((message) => message.role === "user")).toHaveLength(2);
  });

  test("keeps the turn on disk when the provider fails", async () => {
    const controller = new AgentController("google", "key", {});
    await controller.initialize();
    globalMockClient.setThrowError(new Error("provider exploded"));

    await expect(controller.run("Prompt")).rejects.toThrow("provider exploded");

    expect(saveConversation).toHaveBeenCalled();
    const saved = saveConversation.mock.calls.at(-1)?.[0] as Message[];
    expect(saved.at(-1)).toMatchObject({ role: "user", content: "Prompt" });
  });

  test("a failed save is reported but does not fail the turn", async () => {
    const errors: Error[] = [];
    const controller = new AgentController("google", "key", {
      onError: (error) => errors.push(error),
    });
    await controller.initialize();

    saveConversation.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
    globalMockClient.setEvents([createTextEvent("answer"), createDoneEvent()]);

    await expect(controller.run("Prompt")).resolves.toBe("answer");
    expect(errors[0]?.message).toContain("Could not save conversation history");
  });
});
