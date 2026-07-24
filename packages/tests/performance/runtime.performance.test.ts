import { test, expect, describe, mock } from "bun:test";
import { agentLoop } from "../../../config/runtime";
import type { Message } from "../../../config/types";
import { MockTool, MockToolRegistry, CallbackSpy } from "../shared/mocks";
import { createStreamingProvider } from "../shared/testHelpers";
import {
  createTextEvent,
  createDoneEvent,
  createToolCallEvent,
  createUserMessage,
} from "../shared/factories";

const mockToolRegistry = new MockToolRegistry();
const getTool = mock((name: string) => mockToolRegistry.get(name));
mock.module("../../../tools", () => ({ getTool }));

/**
 * PERFORMANCE REGRESSION TESTS
 * 
 * These tests detect algorithmic regressions (e.g., O(n²) → O(n)).
 * Uses generous thresholds (3x expected) to avoid flakiness.
 * 
 * Focus: Detect major slowdowns, not micro-optimizations.
 */

describe("Runtime - Performance Regression Tests", () => {
  test("agent loop completes in reasonable time (10 iterations)", async () => {
    const tool = new MockTool("test_tool", "Result");
    mockToolRegistry.register(tool);

    const messages: Message[] = [createUserMessage("Test")];
    const callbacks = new CallbackSpy();

    // 9 tool calls (stay under MAX_ITERATIONS=10)
    const iterations = [
      ...Array(9).fill(null).map((_, i) => [
        createToolCallEvent("test_tool", { iteration: i }),
        createDoneEvent(),
      ]),
      [createTextEvent("Done"), createDoneEvent()],
    ];

    const provider = createStreamingProvider(iterations);

    const start = performance.now();
    await agentLoop(provider, messages, "", callbacks);
    const elapsed = performance.now() - start;

    // Should complete in <1s (very generous)
    expect(elapsed).toBeLessThan(1000);
  });

  test("agent loop scales linearly with iterations", async () => {
    const tool = new MockTool("test_tool", "Result");
    mockToolRegistry.register(tool);

    // Measure 2 iterations
    const messages1: Message[] = [createUserMessage("Test")];
    const callbacks1 = new CallbackSpy();
    const iterations1 = [
      [createToolCallEvent("test_tool", { i: 0 }), createDoneEvent()],
      [createToolCallEvent("test_tool", { i: 1 }), createDoneEvent()],
      [createTextEvent("Done"), createDoneEvent()],
    ];
    const provider1 = createStreamingProvider(iterations1);

    const start1 = performance.now();
    await agentLoop(provider1, messages1, "", callbacks1);
    const time2 = performance.now() - start1;

    // Measure 8 iterations
    const messages2: Message[] = [createUserMessage("Test")];
    const callbacks2 = new CallbackSpy();
    const iterations2 = [
      ...Array(8).fill(null).map((_, i) => [
        createToolCallEvent("test_tool", { i }),
        createDoneEvent(),
      ]),
      [createTextEvent("Done"), createDoneEvent()],
    ];
    const provider2 = createStreamingProvider(iterations2);

    const start2 = performance.now();
    await agentLoop(provider2, messages2, "", callbacks2);
    const time8 = performance.now() - start2;

    // 8 iterations should be ~4x slower, allow 10x (generous)
    // This detects O(n²) which would be ~16x
    expect(time8).toBeLessThan(Math.max(time2 * 10, 100)); // At least 100ms threshold
  });

  test("large repo context doesn't cause exponential slowdown", async () => {
    const messages: Message[] = [createUserMessage("Test")];
    const callbacks = new CallbackSpy();

    // Test with increasing context sizes
    const context10KB = "x".repeat(10 * 1024);
    const context100KB = "x".repeat(100 * 1024);

    const provider1 = createStreamingProvider([
      [createTextEvent("Response"), createDoneEvent()],
    ]);

    const start1 = performance.now();
    await agentLoop(provider1, messages, context10KB, callbacks);
    const time10KB = performance.now() - start1;

    const messages2: Message[] = [createUserMessage("Test")];
    const callbacks2 = new CallbackSpy();
    const provider2 = createStreamingProvider([
      [createTextEvent("Response"), createDoneEvent()],
    ]);

    const start2 = performance.now();
    await agentLoop(provider2, messages2, context100KB, callbacks2);
    const time100KB = performance.now() - start2;

    // 10x context should not be >20x slower
    expect(time100KB).toBeLessThan(Math.max(time10KB * 20, 100));
  });

  test("large conversation doesn't cause quadratic slowdown", async () => {
    const callbacks1 = new CallbackSpy();
    const messages10: Message[] = [
      createUserMessage("Start"),
      ...Array(9).fill(null).map((_, i) => createUserMessage(`Message ${i}`)),
    ];

    const provider1 = createStreamingProvider([
      [createTextEvent("Response"), createDoneEvent()],
    ]);

    const start1 = performance.now();
    await agentLoop(provider1, messages10, "", callbacks1);
    const time10 = performance.now() - start1;

    const callbacks2 = new CallbackSpy();
    const messages100: Message[] = [
      createUserMessage("Start"),
      ...Array(99).fill(null).map((_, i) => createUserMessage(`Message ${i}`)),
    ];

    const provider2 = createStreamingProvider([
      [createTextEvent("Response"), createDoneEvent()],
    ]);

    const start2 = performance.now();
    await agentLoop(provider2, messages100, "", callbacks2);
    const time100 = performance.now() - start2;

    // 10x messages should not be >50x slower (would indicate O(n²))
    expect(time100).toBeLessThan(Math.max(time10 * 50, 100));
  });

  test("streaming many chunks doesn't hang", async () => {
    const messages: Message[] = [createUserMessage("Test")];
    const callbacks = new CallbackSpy();

    // 1000 text chunks
    const events = [
      ...Array(1000).fill(null).map(() => createTextEvent("x")),
      createDoneEvent(),
    ];

    const provider = createStreamingProvider([events]);

    const start = performance.now();
    await agentLoop(provider, messages, "", callbacks);
    const elapsed = performance.now() - start;

    // Should handle 1000 chunks in <2s
    expect(elapsed).toBeLessThan(2000);
  });
});
