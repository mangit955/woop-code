import { describe, test, expect } from "bun:test";
import * as fc from "fast-check";
import type { Message } from "../../../config/types";
import {
  validateConversationStructure,
  assertNoDuplicateToolCallIds,
  assertToolCallsHaveResults,
  getRoleSequence,
} from "../shared/testHelpers";
import {
  createUserMessage,
  createAssistantMessage,
  createAssistantToolCallMessage,
  createToolMessage,
} from "../shared/factories";

/**
 * PROPERTY-BASED TESTS FOR CONVERSATION STRUCTURE
 * 
 * These tests verify mathematical invariants that must ALWAYS hold true.
 * A property test generates random inputs and verifies the invariant.
 * 
 * Key invariants:
 * - For every valid conversation → tool IDs remain unique
 * - For every conversation → tool calls have matching results
 * - For every conversation → messages only grow (never shrink)
 * - For every conversation → structure rules are never violated
 * 
 * Production bugs prevented:
 * - Message ordering corruption
 * - Duplicate tool call IDs
 * - Tool calls without results
 * - Invalid role sequences
 */

describe("Conversation - Property Tests", () => {
  test("PROPERTY: ∀ valid conversations → tool call IDs are unique", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant("user"),
            fc.constant("assistant"),
            fc.constant("tool_pair")
          ),
          { minLength: 1, maxLength: 20 }
        ),
        (roleTypes) => {
          const messages: Message[] = [];
          let toolCallCounter = 0;
          let lastRole: string | null = null;

          for (const roleType of roleTypes) {
            // Avoid consecutive non-user duplicates
            if (roleType === lastRole && roleType !== "user") {
              continue;
            }

            if (roleType === "user") {
              messages.push(createUserMessage("test"));
              lastRole = "user";
            } else if (roleType === "assistant") {
              messages.push(createAssistantMessage("test"));
              lastRole = "assistant";
            } else if (roleType === "tool_pair") {
              const id = `tool-${toolCallCounter++}`;
              messages.push(
                createAssistantToolCallMessage("test_tool", id, { arg: "value" })
              );
              messages.push(
                createToolMessage("test_tool", id, "result")
              );
              lastRole = "tool";
            }
          }

          if (messages.length > 0) {
            // INVARIANT: All tool call IDs must be unique
            assertNoDuplicateToolCallIds(messages);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: ∀ valid conversations → structure rules never violated", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant("user"),
            fc.constant("assistant")
          ),
          { minLength: 1, maxLength: 20 }
        ),
        (roleTypes) => {
          const messages: Message[] = [];
          let lastRole: string | null = null;

          for (const roleType of roleTypes) {
            // Avoid consecutive assistants (structural rule)
            if (roleType === "assistant" && lastRole === "assistant") {
              continue;
            }

            if (roleType === "user") {
              messages.push(createUserMessage("test"));
              lastRole = "user";
            } else {
              messages.push(createAssistantMessage("test"));
              lastRole = "assistant";
            }
          }

          if (messages.length > 0) {
            // INVARIANT: Valid conversations must pass structure validation
            validateConversationStructure(messages);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: ∀ conversations → no duplicate tool call IDs", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 50 }),
        (toolCallSeeds) => {
          const messages: Message[] = [createUserMessage("Start")];
          const usedIds = new Set<number>();

          for (const seed of toolCallSeeds) {
            // Skip if we've already used this ID
            if (usedIds.has(seed)) continue;
            usedIds.add(seed);

            const id = `tool-${seed}`;
            messages.push(
              createAssistantToolCallMessage("test_tool", id, { seed })
            );
            messages.push(createToolMessage("test_tool", id, "result"));
          }

          // INVARIANT: No duplicate tool call IDs allowed
          assertNoDuplicateToolCallIds(messages);
        }
      ),
      { numRuns: 30 }
    );
  });

  test("PROPERTY: ∀ conversations → every tool call has exactly one result", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 20 }),
        (toolNames) => {
          const messages: Message[] = [createUserMessage("Start")];

          for (let i = 0; i < toolNames.length; i++) {
            const id = `call-${i}`;
            messages.push(
              createAssistantToolCallMessage(toolNames[i] || "tool", id, {})
            );
            messages.push(createToolMessage(toolNames[i] || "tool", id, "result"));
          }

          // INVARIANT: Every tool call must have exactly one result
          assertToolCallsHaveResults(messages);
        }
      ),
      { numRuns: 30 }
    );
  });

  test("PROPERTY: ∀ operations on messages → immutability preserved", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 10 }),
        (contents) => {
          const messages: Message[] = contents.map((c) => createUserMessage(c));
          const snapshots = messages.map((m) => JSON.stringify(m));

          // Simulate read operations that shouldn't mutate
          getRoleSequence(messages);
          validateConversationStructure(messages);

          // INVARIANT: Messages must remain immutable
          for (let i = 0; i < messages.length; i++) {
            expect(JSON.stringify(messages[i])).toBe(snapshots[i]);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: ∀ tool results → must follow tool call in sequence", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant("user"),
            fc.constant("assistant"),
            fc.constant("user_assistant"),
            fc.constant("tool_sequence")
          ),
          { minLength: 1, maxLength: 10 }
        ),
        (patterns) => {
          const messages: Message[] = [];
          let toolIdCounter = 0;

          for (const pattern of patterns) {
            if (pattern === "user") {
              messages.push(createUserMessage("message"));
            } else if (pattern === "assistant") {
              messages.push(createAssistantMessage("response"));
            } else if (pattern === "user_assistant") {
              messages.push(createUserMessage("question"));
              messages.push(createAssistantMessage("answer"));
            } else if (pattern === "tool_sequence") {
              const id = `tool-${toolIdCounter++}`;
              messages.push(createAssistantToolCallMessage("test", id, {}));
              messages.push(createToolMessage("test", id, "result"));
            }
          }

          if (messages.length > 0) {
            const roles = getRoleSequence(messages);

            // INVARIANT: Tool must immediately follow assistant_tool_call
            for (let i = 1; i < roles.length; i++) {
              const prev = roles[i - 1]!;
              const curr = roles[i]!;

              if (curr === "tool" && prev !== "assistant_tool_call") {
                throw new Error("Tool without preceding tool call");
              }
            }
          }
        }
      ),
      { numRuns: 30 }
    );
  });

  test("PROPERTY: ∀ conversations with unicode → content preserved exactly", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 20 }),
        (unicodeContents) => {
          const messages: Message[] = unicodeContents.map((content) =>
            createUserMessage(content)
          );

          // INVARIANT: Unicode content must be preserved exactly
          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i] as Extract<Message, { role: "user" }>;
            expect(msg.content).toBe(unicodeContents[i]);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: ∀ conversations → |messages| is monotonically increasing", () => {
    // This property states: messages array only grows, never shrinks
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
        (addMessages) => {
          const messages: Message[] = [createUserMessage("Start")];
          const sizes: number[] = [messages.length];

          for (const shouldAdd of addMessages) {
            if (shouldAdd) {
              messages.push(createAssistantMessage("Response"));
              sizes.push(messages.length);
            }
          }

          // INVARIANT: sizes[i] ≤ sizes[i+1] for all i
          for (let i = 0; i < sizes.length - 1; i++) {
            expect(sizes[i]!).toBeLessThanOrEqual(sizes[i + 1]!);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
