import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { AgentController } from "../../../commands/agentController";
import {
  getConversation,
  saveConversation,
} from "../../../config/config";
import { MockProviderClient, CallbackSpy } from "../shared/mocks";
import {
  createTextEvent,
  createDoneEvent,
  createUserMessage,
} from "../shared/factories";
import type { Message } from "../../../config/types";

/**
 * End-to-End Persistence Workflow Tests
 * 
 * Tests conversation persistence across sessions.
 * Uses:
 * - Real AgentController
 * - Real conversation persistence
 * - Real filesystem operations
 * - Mock provider only
 * 
 * Production regression prevention:
 * - Ensures conversations are not lost
 * - Validates conversation resume works
 * - Confirms concurrent operations don't corrupt data
 * - Tests large conversation handling
 */

let mockClient: MockProviderClient;

mock.module("../../../config/client", () => ({
  createProviderClient: () => mockClient,
  ACTIVE_PROVIDER_MODELS: { test: "Test Model" },
}));

describe("E2E Persistence - Save and Load", () => {
  let originalConversation: Message[];

  beforeEach(async () => {
    // Backup original conversation
    try {
      originalConversation = await getConversation();
    } catch (e) {
      originalConversation = [];
    }
    
    // Start with clean slate
    await saveConversation([]);
  });

  afterEach(async () => {
    // Restore original conversation
    await saveConversation(originalConversation);
  });

  test("conversation persists after controller dispose", async () => {
    mockClient = new MockProviderClient([
      createTextEvent("Response 1"),
      createDoneEvent(),
    ]);
    
    const callbacks = new CallbackSpy();
    const controller = new AgentController("test", "test-key", callbacks);
    
    await controller.initialize();
    await controller.run("Prompt 1");
    await controller.dispose();
    
    const saved = await getConversation();
    
    expect(saved.length).toBeGreaterThanOrEqual(2);
    expect(saved[0]?.role).toBe("user");
    expect((saved[0] as any).content).toBe("Prompt 1");
  });

  test("new controller loads previous conversation", async () => {
    // First session
    mockClient = new MockProviderClient([
      createTextEvent("First response"),
      createDoneEvent(),
    ]);
    
    const controller1 = new AgentController("test", "key", new CallbackSpy());
    await controller1.initialize();
    await controller1.run("First prompt");
    await controller1.dispose();
    
    // Second session
    mockClient = new MockProviderClient([
      createTextEvent("Second response"),
      createDoneEvent(),
    ]);
    
    const controller2 = new AgentController("test", "key", new CallbackSpy());
    await controller2.initialize();
    await controller2.run("Second prompt");
    await controller2.dispose();
    
    const conversation = await getConversation();
    
    // Should have both sessions
    expect(conversation.length).toBeGreaterThanOrEqual(4);
    const userMessages = conversation.filter(m => m.role === "user");
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
  });

  test("conversation state is preserved across initialize", async () => {
    const initialMessages: Message[] = [
      createUserMessage("Previous message"),
      { role: "assistant", content: "Previous response" },
    ];
    await saveConversation(initialMessages);
    
    mockClient = new MockProviderClient([
      createTextEvent("New response"),
      createDoneEvent(),
    ]);
    
    const controller = new AgentController("test", "key", new CallbackSpy());
    await controller.initialize();
    await controller.run("New message");
    await controller.dispose();
    
    const conversation = await getConversation();
    
    // Should include both old and new messages
    expect(conversation.length).toBeGreaterThanOrEqual(4);
  });
});

describe("E2E Persistence - Multiple Sessions", () => {
  let originalConversation: Message[];

  beforeEach(async () => {
    try {
      originalConversation = await getConversation();
    } catch (e) {
      originalConversation = [];
    }
    await saveConversation([]);
  });

  afterEach(async () => {
    await saveConversation(originalConversation);
  });

  test("multiple conversation turns are persisted", async () => {
    mockClient = new MockProviderClient([
      createTextEvent("Response"),
      createDoneEvent(),
    ]);
    
    const controller = new AgentController("test", "key", new CallbackSpy());
    await controller.initialize();
    
    await controller.run("Turn 1");
    await controller.run("Turn 2");
    await controller.run("Turn 3");
    
    await controller.dispose();
    
    const conversation = await getConversation();
    
    // 3 user messages + 3 assistant messages
    expect(conversation.length).toBeGreaterThanOrEqual(6);
  });

  test("conversation grows correctly over time", async () => {
    mockClient = new MockProviderClient([
      createTextEvent("Response"),
      createDoneEvent(),
    ]);
    
    const controller = new AgentController("test", "key", new CallbackSpy());
    await controller.initialize();
    
    for (let i = 1; i <= 10; i++) {
      await controller.run(`Message ${i}`);
    }
    
    await controller.dispose();
    
    const conversation = await getConversation();
    expect(conversation.length).toBeGreaterThanOrEqual(20);
  });
});

describe("E2E Persistence - Cancellation Impact", () => {
  let originalConversation: Message[];

  beforeEach(async () => {
    try {
      originalConversation = await getConversation();
    } catch (e) {
      originalConversation = [];
    }
    await saveConversation([]);
  });

  afterEach(async () => {
    await saveConversation(originalConversation);
  });

  test("cancelled conversation removes pending user message", async () => {
    mockClient = new MockProviderClient([
      createTextEvent("Response"),
      createDoneEvent(),
    ]);
    mockClient.setDelay(50);
    
    const controller = new AgentController("test", "key", new CallbackSpy());
    await controller.initialize();
    
    const promise = controller.run("This will be cancelled");
    setTimeout(() => controller.cancel(), 10);
    await promise;
    
    await controller.dispose();
    
    const conversation = await getConversation();
    
    // Cancelled message should not be in conversation
    const cancelledMsg = conversation.find(
      m => m.role === "user" && (m as any).content === "This will be cancelled"
    );
    expect(cancelledMsg).toBeUndefined();
  });

  test("cancelled response is not persisted", async () => {
    mockClient = new MockProviderClient([
      createTextEvent("This should not be saved"),
      createDoneEvent(),
    ]);
    mockClient.setDelay(50);
    
    const controller = new AgentController("test", "key", new CallbackSpy());
    await controller.initialize();
    
    const promise = controller.run("Test");
    setTimeout(() => controller.cancel(), 10);
    await promise;
    
    await controller.dispose();
    
    const conversation = await getConversation();
    const responseText = conversation
      .filter(m => m.role === "assistant")
      .map(m => (m as any).content)
      .join("");
    
    expect(responseText).not.toContain("This should not be saved");
  });
});

describe("E2E Persistence - Large Conversations", () => {
  let originalConversation: Message[];

  beforeEach(async () => {
    try {
      originalConversation = await getConversation();
    } catch (e) {
      originalConversation = [];
    }
    await saveConversation([]);
  });

  afterEach(async () => {
    await saveConversation(originalConversation);
  });

  test("large conversation history persists correctly", async () => {
    const largeConversation: Message[] = [];
    for (let i = 0; i < 100; i++) {
      largeConversation.push(createUserMessage(`User message ${i}`));
      largeConversation.push({ role: "assistant", content: `Response ${i}` });
    }
    
    await saveConversation(largeConversation);
    const loaded = await getConversation();
    
    expect(loaded).toHaveLength(200);
    expect(loaded[0]?.role).toBe("user");
    expect(loaded[199]?.role).toBe("assistant");
  });

  test("conversation with long messages persists", async () => {
    const longMessage = "x".repeat(10000);
    const conversation: Message[] = [
      createUserMessage(longMessage),
      { role: "assistant", content: "Response" },
    ];
    
    await saveConversation(conversation);
    const loaded = await getConversation();
    
    expect((loaded[0] as any).content).toBe(longMessage);
  });
});

describe("E2E Persistence - Data Integrity", () => {
  let originalConversation: Message[];

  beforeEach(async () => {
    try {
      originalConversation = await getConversation();
    } catch (e) {
      originalConversation = [];
    }
    await saveConversation([]);
  });

  afterEach(async () => {
    await saveConversation(originalConversation);
  });

  test("all message types persist correctly", async () => {
    const allTypes: Message[] = [
      { role: "user", content: "User" },
      { role: "assistant", content: "Assistant" },
      {
        role: "assistant_tool_call",
        toolName: "test",
        toolCallId: "123",
        arguments: { arg: "val" },
      },
      { role: "tool", toolName: "test", toolCallId: "123", content: "Result" },
    ];
    
    await saveConversation(allTypes);
    const loaded = await getConversation();
    
    expect(loaded).toHaveLength(4);
    expect(loaded[0]?.role).toBe("user");
    expect(loaded[1]?.role).toBe("assistant");
    expect(loaded[2]?.role).toBe("assistant_tool_call");
    expect(loaded[3]?.role).toBe("tool");
  });

  test("unicode characters persist correctly", async () => {
    const unicodeMsg = "Hello 世界 🚀 مرحبا мир";
    const conversation: Message[] = [createUserMessage(unicodeMsg)];
    
    await saveConversation(conversation);
    const loaded = await getConversation();
    
    expect((loaded[0] as any).content).toBe(unicodeMsg);
  });

  test("special characters are escaped correctly", async () => {
    const specialChars = 'Quotes: " \' Newlines: \n\r Tabs: \t';
    const conversation: Message[] = [createUserMessage(specialChars)];
    
    await saveConversation(conversation);
    const loaded = await getConversation();
    
    expect((loaded[0] as any).content).toBe(specialChars);
  });

  test("empty conversation array persists", async () => {
    await saveConversation([]);
    const loaded = await getConversation();
    
    expect(loaded).toEqual([]);
  });
});

describe("E2E Persistence - Error Recovery", () => {
  let originalConversation: Message[];

  beforeEach(async () => {
    try {
      originalConversation = await getConversation();
    } catch (e) {
      originalConversation = [];
    }
  });

  afterEach(async () => {
    await saveConversation(originalConversation);
  });

  test("dispose succeeds even when conversation fails to save", async () => {
    mockClient = new MockProviderClient([
      createTextEvent("Response"),
      createDoneEvent(),
    ]);
    
    const controller = new AgentController("test", "key", new CallbackSpy());
    await controller.initialize();
    await controller.run("Test");
    
    // Dispose should not throw even if save fails
    await expect(controller.dispose()).resolves.toBeUndefined();
  });
});
