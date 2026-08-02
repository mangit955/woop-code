import { describe, test, expect, mock } from "bun:test";
import { agentLoop } from "../../../config/runtime";
import { MockTool, MockToolRegistry } from "../shared/mocks";
import { createRuntimeTest } from "../shared/testHelpers";
import {
  createDoneEvent,
  createTextEvent,
  createToolCallEvent,
} from "../shared/factories";
import type { StreamEvent, TurnSummary } from "../../../config/types";

const mockToolRegistry = new MockToolRegistry();
const getTool = mock((name: string) => mockToolRegistry.get(name));
const actualTools = await import("../../../tools");
mock.module("../../../tools", () => ({ ...actualTools, getTool }));

const SOCKET_CLOSED = "The socket connection was closed unexpectedly.";

/**
 * A provider whose stream yields the given events for each iteration and then
 * throws, reproducing a connection dropped part-way through a response.
 */
function failingAfter(iterations: StreamEvent[][], failOn: number[]): any {
  let n = 0;
  return {
    async *stream() {
      const index = n++;
      for (const event of iterations[index] ?? []) {
        yield event;
      }
      if (failOn.includes(index)) {
        throw new Error(SOCKET_CLOSED);
      }
    },
  };
}

function summaryOf(callbacks: {
  getCallsByName(name: string): Array<{ args: any[] }>;
}): TurnSummary {
  const calls = callbacks.getCallsByName("onTurnSummary");
  expect(calls.length).toBe(1);
  return calls[0]!.args[0] as TurnSummary;
}

describe("agentLoop - salvaging a truncated response", () => {
  test("keeps partial text and asks again instead of ending the turn", async () => {
    const { callbacks, messages } = createRuntimeTest();

    const provider = failingAfter(
      [
        [createTextEvent("Looking at the")],
        [createTextEvent("Done."), createDoneEvent()],
      ],
      [0],
    );

    const result = await agentLoop(provider, messages, "", callbacks);

    // Returning after the cut would have ended the turn on a half-written
    // sentence; the loop asks again and the model finishes.
    expect(result).toBe("Done.");
    expect(summaryOf(callbacks).salvagedIterations).toBe(1);
    expect(callbacks.getCallsByName("onError").length).toBe(0);
  });

  test("the partial text stays in the conversation for the model to continue", async () => {
    const { callbacks, messages } = createRuntimeTest();

    const provider = failingAfter(
      [
        [createTextEvent("The parser fails because")],
        [createTextEvent(" the lexer drops a token."), createDoneEvent()],
      ],
      [0],
    );

    await agentLoop(provider, messages, "", callbacks);

    const assistants = messages.filter((m) => m.role === "assistant");
    expect(assistants[0]).toMatchObject({
      content: "The parser fails because",
    });
  });

  test("nothing synthetic is injected, so the turn window is unchanged", async () => {
    const { callbacks, messages } = createRuntimeTest();

    const provider = failingAfter(
      [[createTextEvent("cut")], [createTextEvent("done"), createDoneEvent()]],
      [0],
    );

    await agentLoop(provider, messages, "", callbacks);

    // A fabricated user message would consume one of the turns recentMessages
    // keeps, silently shortening the model's memory.
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  test("tool calls that did arrive are still executed", async () => {
    const { callbacks, messages } = createRuntimeTest();
    mockToolRegistry.register(new MockTool("read_file", "file contents"));

    const provider = failingAfter(
      [
        [createToolCallEvent("read_file", { path: "a.ts" }, "c1")],
        [createTextEvent("Read it."), createDoneEvent()],
      ],
      [0],
    );

    await agentLoop(provider, messages, "", callbacks);

    expect(callbacks.getCallsByName("onToolFinish").length).toBe(1);
    expect(summaryOf(callbacks).salvagedIterations).toBe(1);
  });

  test("a failure before any output is not salvaged", async () => {
    const { callbacks, messages } = createRuntimeTest();

    const provider = failingAfter([[]], [0]);

    // The client already exhausted its retries, so there is nothing to keep
    // and the failure must travel rather than be silently absorbed.
    await expect(agentLoop(provider, messages, "", callbacks)).rejects.toThrow(
      /socket connection/,
    );
    expect(summaryOf(callbacks).salvagedIterations).toBe(0);
    expect(callbacks.getCallsByName("onError").length).toBe(1);
  });

  test("a fatal failure after output is reported, not continued from", async () => {
    const { callbacks, messages } = createRuntimeTest();

    const provider = {
      async *stream() {
        yield createTextEvent("Starting");
        throw Object.assign(new Error("Bad request"), { status: 400 });
      },
    } as any;

    // Continuing here would spend the whole iteration budget rediscovering an
    // error that was already final on the first attempt.
    await expect(agentLoop(provider, messages, "", callbacks)).rejects.toThrow(
      /Bad request/,
    );
    expect(summaryOf(callbacks).iterations).toBe(1);
    expect(summaryOf(callbacks).salvagedIterations).toBe(0);
  });

  test("a cancelled turn is not treated as a truncated one", async () => {
    const { callbacks, messages } = createRuntimeTest();
    const controller = new AbortController();

    const provider = {
      async *stream() {
        yield createTextEvent("partial");
        controller.abort();
        throw new Error(SOCKET_CLOSED);
      },
    } as any;

    const result = await agentLoop(
      provider,
      messages,
      "",
      callbacks,
      controller.signal,
    );

    expect(result).toBe("");
    expect(callbacks.getCallsByName("onCancel").length).toBeGreaterThan(0);
    expect(summaryOf(callbacks).salvagedIterations).toBe(0);
  });

  test("repeated truncation still ends, bounded by the iteration budget", async () => {
    const { callbacks, messages } = createRuntimeTest();

    const provider = {
      async *stream() {
        yield createTextEvent("cut");
        throw new Error(SOCKET_CLOSED);
      },
    } as any;

    // Salvaging must not become an unbounded retry: the loop budget is what
    // stops a permanently broken connection from spinning forever.
    await expect(agentLoop(provider, messages, "", callbacks)).rejects.toThrow(
      /maximum number of iterations/,
    );
    expect(summaryOf(callbacks).salvagedIterations).toBeGreaterThan(1);
  });
});
