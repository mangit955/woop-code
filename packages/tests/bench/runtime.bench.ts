import { bench, describe } from "bun:test";
import { agentLoop } from "../../../config/runtime";
import { MockTool, MockToolRegistry, CallbackSpy } from "../shared/mocks";
import { createStreamingProvider } from "../shared/testHelpers";
import {
  createTextEvent,
  createDoneEvent,
  createToolCallEvent,
  createUserMessage,
} from "../shared/factories";
import type { Message } from "../../../config/types";

/**
 * PERFORMANCE BENCHMARKS FOR RUNTIME
 * 
 * These establish baseline performance metrics and detect
 * algorithmic regressions (e.g., O(n²) instead of O(n)).
 * 
 * Baseline expectations:
 * - Small (10 messages): <50ms
 * - Medium (100 messages): <200ms
 * - Large (1000 messages): <500ms
 */

// Setup mock tool registry
const mockToolRegistry = new MockToolRegistry();
const tool = new MockTool("test_tool", "Result");
mockToolRegistry.register(tool);

// Mock getTool for benchmarks
const getTool = (name: string) => mockToolRegistry.get(name);
(globalThis as any).getTool = getTool;

describe("Runtime Benchmarks", () => {
  bench("agent loop - text only (10 iterations)", async () => {
    const messages: Message[] = [createUserMessage("Test")];
    const callbacks = new CallbackSpy();

    const iterations = Array(10).fill([
      createTextEvent("Response text"),
      createDoneEvent(),
    ]);

    const provider = createStreamingProvider(iterations);
    await agentLoop(provider, messages, "", callbacks);
  });

  bench("agent loop - text only (100 chunks)", async () => {
    const messages: Message[] = [createUserMessage("Test")];
    const callbacks = new CallbackSpy();

    // Single iteration with 100 text chunks
    const events = [
      ...Array(100).fill(null).map((_, i) => createTextEvent(`Chunk ${i}`)),
      createDoneEvent(),
    ];

    const provider = createStreamingProvider([events]);
    await agentLoop(provider, messages, "", callbacks);
  });

  bench("agent loop - with tool calls (5 tools)", async () => {
    const messages: Message[] = [createUserMessage("Test")];
    const callbacks = new CallbackSpy();

    // 5 tool calls followed by text response
    const iterations = [
      ...Array(5).fill(null).map((_, i) => [
        createToolCallEvent("test_tool", { iteration: i }),
        createDoneEvent(),
      ]),
      [createTextEvent("Final response"), createDoneEvent()],
    ];

    const provider = createStreamingProvider(iterations);
    await agentLoop(provider, messages, "", callbacks);
  });

  bench("agent loop - large repo context (100KB)", async () => {
    const messages: Message[] = [createUserMessage("Test")];
    const callbacks = new CallbackSpy();
    const largeContext = "x".repeat(100 * 1024); // 100KB

    const provider = createStreamingProvider([
      [createTextEvent("Response"), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, largeContext, callbacks);
  });

  bench("agent loop - large conversation (100 messages)", async () => {
    const messages: Message[] = [
      createUserMessage("Start"),
      ...Array(99).fill(null).map((_, i) => 
        i % 2 === 0 
          ? createUserMessage(`Message ${i}`)
          : { role: "assistant" as const, content: `Response ${i}` }
      ),
    ];
    const callbacks = new CallbackSpy();

    const provider = createStreamingProvider([
      [createTextEvent("Response"), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);
  });

  bench("agent loop - mixed operations (realistic)", async () => {
    const messages: Message[] = [createUserMessage("Test")];
    const callbacks = new CallbackSpy();

    // Realistic pattern: text, tool, tool, text
    const iterations = [
      [createTextEvent("Analyzing..."), createDoneEvent()],
      [createToolCallEvent("test_tool", { file: "test.ts" }), createDoneEvent()],
      [createToolCallEvent("test_tool", { file: "main.ts" }), createDoneEvent()],
      [createTextEvent("Analysis complete"), createDoneEvent()],
    ];

    const provider = createStreamingProvider(iterations);
    await agentLoop(provider, messages, "", callbacks);
  });

  bench("agent loop - streaming throughput (1000 chunks)", async () => {
    const messages: Message[] = [createUserMessage("Test")];
    const callbacks = new CallbackSpy();

    const events = [
      ...Array(1000).fill(null).map(() => createTextEvent("x")),
      createDoneEvent(),
    ];

    const provider = createStreamingProvider([events]);
    await agentLoop(provider, messages, "", callbacks);
  });

  bench("agent loop - unicode heavy content", async () => {
    const messages: Message[] = [createUserMessage("Test")];
    const callbacks = new CallbackSpy();

    const unicodeText = "世界 🚀 مرحبا עברית ".repeat(100);
    const provider = createStreamingProvider([
      [createTextEvent(unicodeText), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);
  });
});

describe("Message Operations Benchmarks", () => {
  bench("message append (sequential)", () => {
    const messages: Message[] = [createUserMessage("Start")];

    for (let i = 0; i < 100; i++) {
      messages.push(createUserMessage(`Message ${i}`));
    }
  });

  bench("message array clone (100 messages)", () => {
    const messages: Message[] = Array(100).fill(null).map((_, i) => 
      createUserMessage(`Message ${i}`)
    );

    const cloned = JSON.parse(JSON.stringify(messages));
  });

  bench("message array clone (1000 messages)", () => {
    const messages: Message[] = Array(1000).fill(null).map((_, i) => 
      createUserMessage(`Message ${i}`)
    );

    const cloned = JSON.parse(JSON.stringify(messages));
  });
});
