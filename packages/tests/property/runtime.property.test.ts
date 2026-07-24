import { describe, test, expect, beforeEach, mock } from "bun:test";
import * as fc from "fast-check";
import { agentLoop } from "../../../config/runtime";
import type { Message, StreamEvent } from "../../../config/types";
import { MockTool, MockToolRegistry } from "../shared/mocks";
import {
  createStreamingProvider,
  validateConversationStructure,
} from "../shared/testHelpers";
import {
  createTextEvent,
  createDoneEvent,
  createToolCallEvent,
  createUserMessage,
} from "../shared/factories";
import { CallbackSpy } from "../shared/mocks";

const mockToolRegistry = new MockToolRegistry();
const getTool = mock((name: string) => mockToolRegistry.get(name));
mock.module("../../../tools", () => ({ getTool }));

/**
 * PROPERTY-BASED TESTS FOR RUNTIME
 * 
 * These tests verify mathematical invariants in the runtime system.
 * 
 * Key invariants:
 * - ∀ text chunks → concatenation equals final assistant message
 * - ∀ iterations → messages only grow monotonically  
 * - ∀ unicode input → output preserves it exactly
 * - ∀ same (tool, args) pair → tool loop detected
 * 
 * Production bugs prevented:
 * - Text streaming corruption
 * - Unicode edge cases crashing runtime
 * - Message array mutations
 * - Tool loop detection failures
 */

describe("Runtime - Property Tests", () => {
  beforeEach(() => {
    mockToolRegistry.clear();
  });

  test("PROPERTY: ∀ text chunks → concat(chunks) = final assistant content", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { minLength: 1, maxLength: 20 }),
        async (textChunks) => {
          const callbacks = new CallbackSpy();
          const messages: Message[] = [createUserMessage("Test")];

          // Create provider that streams text chunks
          const events: StreamEvent[] = [
            ...textChunks.map(createTextEvent),
            createDoneEvent(),
          ];
          const provider = createStreamingProvider([events]);

          await agentLoop(provider, messages, "", callbacks);

          // INVARIANT: concatenation of chunks = final message content
          const expectedContent = textChunks.join("");
          const lastMessage = messages[messages.length - 1]!;
          expect(lastMessage.role).toBe("assistant");
          const actualContent = (
            lastMessage as Extract<Message, { role: "assistant" }>
          ).content;
          expect(actualContent).toBe(expectedContent);
        }
      ),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: ∀ operations → conversation structure remains valid", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.constant("text"),
            fc.constant("tool"),
          ),
          { minLength: 1, maxLength: 5 }
        ),
        async (operations) => {
          const tool = new MockTool("test_tool", "Result");
          mockToolRegistry.register(tool);

          const callbacks = new CallbackSpy();
          const messages: Message[] = [createUserMessage("Test")];

          // Build iteration sequence based on random operations
          const iterations: StreamEvent[][] = [];
          let toolCounter = 0;
          for (const op of operations) {
            if (op === "text") {
              iterations.push([
                createTextEvent("Random text"),
                createDoneEvent(),
              ]);
            } else if (op === "tool") {
              // Use different arguments to avoid loop detection
              iterations.push([
                createToolCallEvent("test_tool", { iteration: toolCounter++ }),
                createDoneEvent(),
              ]);
            }
          }

          // Final text response to terminate
          iterations.push([createTextEvent("Final"), createDoneEvent()]);

          const provider = createStreamingProvider(iterations);

          await agentLoop(provider, messages, "", callbacks);

          // INVARIANT: Conversation structure must always be valid
          validateConversationStructure(messages);
          expect(messages.length).toBeGreaterThan(1);
        }
      ),
      { numRuns: 30 }
    );
  });

  test("PROPERTY: ∀ unicode text → preserved exactly in output", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (unicodeText) => {
        if (unicodeText.length === 0) return; // Skip empty strings

        const callbacks = new CallbackSpy();
        const messages: Message[] = [createUserMessage("Test")];

        const provider = createStreamingProvider([
          [createTextEvent(unicodeText), createDoneEvent()],
        ]);

        await agentLoop(provider, messages, "", callbacks);

        const lastMessage = messages[messages.length - 1]!;
        expect(lastMessage.role).toBe("assistant");
        const content = (lastMessage as Extract<Message, { role: "assistant" }>)
          .content;

        // INVARIANT: Unicode must be preserved exactly
        expect(content).toBe(unicodeText);
      }),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: ∀ (tool, args) duplicates → loop detection triggers", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          arg1: fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
          arg2: fc.oneof(fc.string(), fc.integer()),
        }),
        async (args) => {
          const tool = new MockTool("test_tool", "Result");
          mockToolRegistry.register(tool);

          const callbacks = new CallbackSpy();
          const messages: Message[] = [createUserMessage("Test")];

          // INVARIANT: Calling same tool with same args twice = loop detection
          const provider = createStreamingProvider([
            [createToolCallEvent("test_tool", args), createDoneEvent()],
            [createToolCallEvent("test_tool", args), createDoneEvent()], // Duplicate!
          ]);

          await expect(
            agentLoop(provider, messages, "", callbacks)
          ).rejects.toThrow("Tool loop detected");
        }
      ),
      { numRuns: 30 }
    );
  });

  test("PROPERTY: ∀ operations → messages.length monotonically increases", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
        async (hasToolCalls) => {
          const tool = new MockTool("test_tool", "Result");
          mockToolRegistry.register(tool);

          const callbacks = new CallbackSpy();
          const messages: Message[] = [createUserMessage("Test")];
          const initialLength = messages.length;

          // Use unique arguments to avoid tool loop detection
          let toolCounter = 0;
          const iterations: StreamEvent[][] = hasToolCalls.map((hasTool) =>
            hasTool
              ? [createToolCallEvent("test_tool", { counter: toolCounter++ }), createDoneEvent()]
              : [createTextEvent("Text"), createDoneEvent()]
          );

          // Add final text response
          iterations.push([createTextEvent("Final"), createDoneEvent()]);

          const provider = createStreamingProvider(iterations);

          await agentLoop(provider, messages, "", callbacks);

          // INVARIANT: messages.length only grows (monotonic increase)
          expect(messages.length).toBeGreaterThan(initialLength);

          // Verify no deletions (all indices still defined)
          for (let i = 0; i < messages.length; i++) {
            expect(messages[i]).toBeDefined();
          }
        }
      ),
      { numRuns: 30 }
    );
  });
});
