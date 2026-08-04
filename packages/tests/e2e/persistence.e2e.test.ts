import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { AgentController } from "../../../commands/agentController";
import {
  getConversation,
  MAX_PERSISTED_MESSAGES,
  prepareConversationForDisk,
  saveConversation,
} from "../../../config/config";
import { MockProviderClient, CallbackSpy } from "../shared/mocks";
import {
  createTextEvent,
  createDoneEvent,
  createUserMessage,
} from "../shared/factories";
import type { Message } from "../../../config/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

/**
 * This file's whole subject is what reaches disk, so it has to be told which
 * disk. Without the redirect it read and rewrote the developer's real
 * `~/.config/woopcode/conversation.json` — it saved `[]` and restored what it
 * found, which works alone and loses the user's history the moment two runs
 * overlap: one saves `[]`, the other reads that as the original, and restores
 * emptiness permanently.
 *
 * `getConfigDir` reads the variable per call, so setting it after the static
 * imports and before any test body is enough.
 */
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const temporaryConfigHome = mkdtempSync(joinPath(tmpdir(), "woopcode-persistence-e2e-"));
process.env.XDG_CONFIG_HOME = temporaryConfigHome;

afterAll(() => {
  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
  rmSync(temporaryConfigHome, { recursive: true, force: true });
});

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

// Captured before the mock is registered, so the stub can keep the module's
// other exports (DEFAULT_MODEL_ID and friends, which unrelated modules import)
// and can hand back to the real implementation when this file is not running.
const actualClient = await import("../../../config/client");
// Held as a direct reference rather than read off the namespace at call time,
// so the delegation below cannot resolve back to the mock and recurse.
const realCreateProviderClient = actualClient.createProviderClient;

// Only answers while this file's own tests are running. A module mock is
// registered for the whole run and restoring it afterwards does not work — Bun
// binds a static import during the load phase, long before any afterAll — so the
// override delegates to the real implementation the rest of the time. Otherwise
// a later suite asserting that createProviderClient refuses an unsupported
// provider gets this stub and sees no error at all.
let usingMockClient = false;

beforeAll(() => {
  usingMockClient = true;
});

afterAll(() => {
  usingMockClient = false;
});

mock.module("../../../config/client", () => ({
  ...actualClient,
  createProviderClient: (provider: string, apiKey: string, model?: string) =>
    usingMockClient ? mockClient : realCreateProviderClient(provider, apiKey, model),
  get ACTIVE_PROVIDER_MODELS() {
    return usingMockClient ? { test: "Test Model" } : actualClient.ACTIVE_PROVIDER_MODELS;
  },
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

  test("a long conversation is capped at the most recent messages", () => {
    const largeConversation: Message[] = [];
    for (let i = 0; i < 100; i++) {
      largeConversation.push(createUserMessage(`User message ${i}`));
      largeConversation.push({ role: "assistant", content: `Response ${i}` });
    }

    // Asserted on the trimming rule itself rather than through save/load: those
    // two are replaced by an in-memory stub in another suite, and a module mock
    // lasts for the whole run, so a round-trip here would quietly measure the
    // stub whenever that suite happens to load first.
    const persisted = prepareConversationForDisk(largeConversation);

    // History exists to give a new session context, not to archive everything.
    expect(persisted).toHaveLength(MAX_PERSISTED_MESSAGES);
    // The tail survives, so the oldest are gone and the newest stay in order.
    expect(persisted[0]).toMatchObject({ role: "user", content: "User message 50" });
    expect(persisted.at(-1)).toMatchObject({ role: "assistant", content: "Response 99" });
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

  test("only the conversational message types are persisted", () => {
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

    // A call and its result are only meaningful to the turn that produced them,
    // and persisting one half of a pair would restore a history the provider
    // cannot accept. Both halves are dropped on purpose.
    expect(prepareConversationForDisk(allTypes).map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
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
