import type { Message, StreamEvent } from "../../../config/types";
import { MockProviderClient, MockToolRegistry, CallbackSpy } from "./mocks";
import { createUserMessage } from "./factories";

/**
 * Streaming provider builder for readable test setup
 */
export class StreamingProviderBuilder {
  private iterations: StreamEvent[][] = [];

  iteration(events: StreamEvent[]): this {
    this.iterations.push(events);
    return this;
  }

  build(): any {
    let iterationCount = 0;
    const iterations = this.iterations;

    return {
      async *stream(_msgs: any, _ctx: any, signal?: AbortSignal) {
        if (iterationCount < iterations.length) {
          const events = iterations[iterationCount++];
          for (const event of events!) {
            if (signal?.aborted) return;
            yield event;
          }
        }
      },
    };
  }
}

export function createStreamingProvider(iterations: StreamEvent[][]): any {
  const builder = new StreamingProviderBuilder();
  iterations.forEach((events) => builder.iteration(events));
  return builder.build();
}

/**
 * Test fixture creator for agent loop tests
 */
export interface RuntimeTestFixture {
  provider: MockProviderClient;
  callbacks: CallbackSpy;
  messages: Message[];
  registry: MockToolRegistry;
}

export function createRuntimeTest(): RuntimeTestFixture {
  return {
    provider: new MockProviderClient(),
    callbacks: new CallbackSpy(),
    messages: [createUserMessage("Test prompt")],
    registry: new MockToolRegistry(),
  };
}

/**
 * Conversation structure validation
 */
export function validateConversationStructure(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    // Tool result must follow tool call
    if (msg.role === "tool") {
      const prev = messages[i - 1];
      if (!prev || prev.role !== "assistant_tool_call") {
        throw new Error(
          `Invalid conversation: tool message at index ${i} not preceded by assistant_tool_call`,
        );
      }

      // Tool IDs must match
      const prevCall = prev as Extract<Message, { role: "assistant_tool_call" }>;
      const toolMsg = msg as Extract<Message, { role: "tool" }>;
      if (prevCall.toolCallId !== toolMsg.toolCallId) {
        throw new Error(
          `Tool call ID mismatch at index ${i}: ${prevCall.toolCallId} vs ${toolMsg.toolCallId}`,
        );
      }
    }

    // No duplicate consecutive roles (except user can follow user)
    if (i > 0) {
      const prev = messages[i - 1]!;
      if (msg.role === prev.role && msg.role !== "user") {
        throw new Error(
          `Invalid conversation: duplicate ${msg.role} at index ${i}`,
        );
      }
    }
  }
}

/**
 * Extract conversation role sequence for assertions
 */
export function getRoleSequence(messages: Message[]): string[] {
  return messages.map((m) => m.role);
}

/**
 * Invariant: Messages array only grows
 */
export function assertMessagesOnlyGrow(
  before: Message[],
  after: Message[],
): void {
  if (after.length < before.length) {
    throw new Error(
      `Messages array shrunk: ${before.length} -> ${after.length}`,
    );
  }

  // Check that original messages weren't mutated
  for (let i = 0; i < before.length; i++) {
    if (JSON.stringify(before[i]) !== JSON.stringify(after[i])) {
      throw new Error(`Message at index ${i} was mutated`);
    }
  }
}

/**
 * Invariant: No duplicate tool call IDs
 */
export function assertNoDuplicateToolCallIds(messages: Message[]): void {
  const toolCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant_tool_call") {
      const id = (msg as Extract<Message, { role: "assistant_tool_call" }>)
        .toolCallId;
      if (toolCallIds.has(id)) {
        throw new Error(`Duplicate tool call ID: ${id}`);
      }
      toolCallIds.add(id);
    }
  }
}

/**
 * Invariant: Every tool call has a result
 */
export function assertToolCallsHaveResults(messages: Message[]): void {
  const toolCalls = new Map<string, boolean>();

  for (const msg of messages) {
    if (msg.role === "assistant_tool_call") {
      const id = (msg as Extract<Message, { role: "assistant_tool_call" }>)
        .toolCallId;
      toolCalls.set(id, false);
    } else if (msg.role === "tool") {
      const id = (msg as Extract<Message, { role: "tool" }>).toolCallId;
      if (!toolCalls.has(id)) {
        throw new Error(`Tool result for unknown call ID: ${id}`);
      }
      toolCalls.set(id, true);
    }
  }

  for (const [id, hasResult] of toolCalls) {
    if (!hasResult) {
      throw new Error(`Tool call ${id} missing result`);
    }
  }
}

/**
 * Invariant: Conversation ends with assistant or tool message
 */
export function assertValidConversationEnd(messages: Message[]): void {
  if (messages.length === 0) return;

  const last = messages[messages.length - 1]!;
  const validEndRoles = ["assistant", "tool"];

  if (!validEndRoles.includes(last.role)) {
    throw new Error(
      `Conversation ends with invalid role: ${last.role}. Expected assistant or tool.`,
    );
  }
}

/**
 * Generate random tool arguments for fuzzing
 */
export function generateRandomToolArgs(): Record<string, unknown> {
  const types = [
    () => Math.random().toString(36),
    () => Math.floor(Math.random() * 10000),
    () => Math.random() > 0.5,
    () => null,
    () => undefined,
    () => ({ nested: Math.random().toString(36) }),
    () => [1, 2, 3],
    () => "",
    () => "x".repeat(Math.floor(Math.random() * 1000)),
  ];

  const args: Record<string, unknown> = {};
  const numArgs = Math.floor(Math.random() * 5);

  for (let i = 0; i < numArgs; i++) {
    const generator = types[Math.floor(Math.random() * types.length)]!;
    args[`arg${i}`] = generator();
  }

  return args;
}

/**
 * Wait with timeout
 */
export async function waitWithTimeout(
  ms: number,
  timeoutMs: number = 5000,
): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), timeoutMs),
    ),
  ]);
}
