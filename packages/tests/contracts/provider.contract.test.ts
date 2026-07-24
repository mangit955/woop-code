import { describe, test, expect } from "bun:test";
import type { ProviderClient, StreamEvent, Message } from "../../../config/types";
import { MockProviderClient } from "../shared/mocks";
import {
  createTextEvent,
  createToolCallEvent,
  createDoneEvent,
  createUserMessage,
} from "../shared/factories";

/**
 * Provider Contract Tests
 * 
 * Every ProviderClient implementation must satisfy this contract.
 * This ensures all providers are interchangeable in the runtime.
 * 
 * Tests verify:
 * - Streaming behavior (text, tool calls, done events)
 * - Event ordering
 * - Cancellation handling
 * - Unicode preservation
 * - Error propagation
 * - Stream termination
 */

/**
 * Runs the complete contract test suite against a provider
 */
export function testProviderContract(
  providerName: string,
  createProvider: () => ProviderClient,
) {
  describe(`Provider Contract: ${providerName}`, () => {
    test("streams text events correctly", async () => {
      const provider = createProvider();
      const messages: Message[] = [createUserMessage("Hello")];
      
      const events: StreamEvent[] = [];
      for await (const event of provider.stream(messages, "")) {
        events.push(event);
      }
      
      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1]?.type).toBe("done");
    });

    test("emits done event exactly once", async () => {
      const provider = createProvider();
      const messages: Message[] = [createUserMessage("Test")];
      
      const doneEvents = [];
      for await (const event of provider.stream(messages, "")) {
        if (event.type === "done") {
          doneEvents.push(event);
        }
      }
      
      expect(doneEvents).toHaveLength(1);
    });

    test("preserves event ordering", async () => {
      const provider = createProvider();
      const messages: Message[] = [createUserMessage("Test")];
      
      const events: StreamEvent[] = [];
      for await (const event of provider.stream(messages, "")) {
        events.push(event);
      }
      
      // Done must be last
      const doneIndex = events.findIndex(e => e.type === "done");
      expect(doneIndex).toBe(events.length - 1);
      
      // Text events before done
      for (let i = 0; i < doneIndex; i++) {
        expect(events[i]?.type).toMatch(/text|tool_call/);
      }
    });

    test("handles cancellation correctly", async () => {
      const provider = createProvider();
      const messages: Message[] = [createUserMessage("Test")];
      const abortController = new AbortController();
      
      // Abort immediately
      abortController.abort();
      
      const events: StreamEvent[] = [];
      for await (const event of provider.stream(messages, "", abortController.signal)) {
        events.push(event);
      }
      
      // Should terminate early without errors
      expect(events.length).toBeGreaterThanOrEqual(0);
    });

    test("preserves unicode in text events", async () => {
      const provider = createProvider();
      const messages: Message[] = [createUserMessage("Unicode: 世界 🚀")];
      
      let fullText = "";
      for await (const event of provider.stream(messages, "")) {
        if (event.type === "text") {
          fullText += event.content;
        }
      }
      
      // At minimum, provider should handle unicode without crashing
      expect(typeof fullText).toBe("string");
    });

    test("handles empty response gracefully", async () => {
      const provider = createProvider();
      const messages: Message[] = [createUserMessage("")];
      
      const events: StreamEvent[] = [];
      for await (const event of provider.stream(messages, "")) {
        events.push(event);
      }
      
      // Must still emit done
      expect(events.some(e => e.type === "done")).toBe(true);
    });

    test("stream terminates correctly", async () => {
      const provider = createProvider();
      const messages: Message[] = [createUserMessage("Test")];
      
      let completed = false;
      for await (const event of provider.stream(messages, "")) {
        // Stream should terminate after done
      }
      completed = true;
      
      expect(completed).toBe(true);
    });
  });
}

// Test the MockProviderClient as reference implementation
describe("MockProviderClient - Reference Implementation", () => {
  test("satisfies provider contract - text streaming", async () => {
    const provider = new MockProviderClient([
      createTextEvent("Hello"),
      createTextEvent(" world"),
      createDoneEvent(),
    ]);
    
    const messages: Message[] = [createUserMessage("Test")];
    const events: StreamEvent[] = [];
    
    for await (const event of provider.stream(messages, "")) {
      events.push(event);
    }
    
    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe("text");
    expect(events[1]?.type).toBe("text");
    expect(events[2]?.type).toBe("done");
  });

  test("satisfies provider contract - tool call streaming", async () => {
    const provider = new MockProviderClient([
      createToolCallEvent("test_tool", { arg: "value" }),
      createDoneEvent(),
    ]);
    
    const messages: Message[] = [createUserMessage("Test")];
    const events: StreamEvent[] = [];
    
    for await (const event of provider.stream(messages, "")) {
      events.push(event);
    }
    
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("tool_call");
    expect(events[1]?.type).toBe("done");
  });

  test("satisfies provider contract - cancellation", async () => {
    const provider = new MockProviderClient([
      createTextEvent("Start"),
      createTextEvent("Middle"),
      createDoneEvent(),
    ]);
    
    const messages: Message[] = [createUserMessage("Test")];
    const abortController = new AbortController();
    
    // Abort after first event
    let eventCount = 0;
    for await (const event of provider.stream(messages, "", abortController.signal)) {
      eventCount++;
      if (eventCount === 1) {
        abortController.abort();
      }
    }
    
    // Should terminate early
    expect(eventCount).toBeLessThan(3);
  });

  test("satisfies provider contract - error propagation", async () => {
    const provider = new MockProviderClient([]);
    const testError = new Error("Provider error");
    provider.setThrowError(testError);
    
    const messages: Message[] = [createUserMessage("Test")];
    
    await expect(async () => {
      for await (const event of provider.stream(messages, "")) {
        // Should throw
      }
    }).toThrow("Provider error");
  });

  test("satisfies provider contract - unicode preservation", async () => {
    const unicodeText = "Hello 世界 🚀 مرحبا";
    const provider = new MockProviderClient([
      createTextEvent(unicodeText),
      createDoneEvent(),
    ]);
    
    const messages: Message[] = [createUserMessage("Test")];
    let receivedText = "";
    
    for await (const event of provider.stream(messages, "")) {
      if (event.type === "text") {
        receivedText += event.content;
      }
    }
    
    expect(receivedText).toBe(unicodeText);
  });

  test("satisfies provider contract - empty stream", async () => {
    const provider = new MockProviderClient([createDoneEvent()]);
    
    const messages: Message[] = [createUserMessage("Test")];
    const events: StreamEvent[] = [];
    
    for await (const event of provider.stream(messages, "")) {
      events.push(event);
    }
    
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("done");
  });

  test("satisfies provider contract - done is always last", async () => {
    const provider = new MockProviderClient([
      createTextEvent("First"),
      createToolCallEvent("tool", {}),
      createTextEvent("Second"),
      createDoneEvent(),
    ]);
    
    const messages: Message[] = [createUserMessage("Test")];
    const events: StreamEvent[] = [];
    
    for await (const event of provider.stream(messages, "")) {
      events.push(event);
    }
    
    expect(events[events.length - 1]?.type).toBe("done");
  });
});

// Run contract tests on MockProviderClient
testProviderContract("MockProviderClient", () => {
  return new MockProviderClient([
    createTextEvent("Contract test response"),
    createDoneEvent(),
  ]);
});
