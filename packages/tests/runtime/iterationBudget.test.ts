import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  agentLoop,
  IterationBudgetExhaustedError,
} from "../../../runtime/loop";
import type {
  AgentCallbacks,
  ProviderClient,
  StreamEvent,
} from "../../../config/types";
import { MockTool, MockToolRegistry } from "../shared/mocks";
import { createRuntimeTest } from "../shared/testHelpers";

const mockToolRegistry = new MockToolRegistry();
const getTool = mock((name: string) => mockToolRegistry.get(name));
const actualTools = await import("../../../tools");
mock.module("../../../tools", () => ({ ...actualTools, getTool }));

/** A provider that never finishes, so the loop always runs out of budget. */
function neverFinishingProvider(): ProviderClient {
  let call = 0;
  return {
    async *stream(): AsyncGenerator<StreamEvent> {
      call += 1;
      yield {
        type: "tool_call",
        id: `call-${call}`,
        name: "loop_tool",
        arguments: {},
      };
      yield { type: "done" };
    },
  } as ProviderClient;
}

const ORIGINAL = process.env.WOOPCODE_MAX_ITERATIONS;

beforeEach(() => {
  mockToolRegistry.clear();
  mockToolRegistry.register(new MockTool("loop_tool", "still going"));
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.WOOPCODE_MAX_ITERATIONS;
  else process.env.WOOPCODE_MAX_ITERATIONS = ORIGINAL;
});

/**
 * Runs the loop to exhaustion and returns the error.
 *
 * The loop reports through `onError` and then rethrows, so both paths are
 * captured and asserted to agree.
 */
async function runToExhaustion(): Promise<Error | undefined> {
  const { callbacks, messages } = createRuntimeTest();
  let reported: Error | undefined;
  callbacks.onError = (error: Error) => {
    reported = error;
  };

  try {
    await agentLoop(neverFinishingProvider(), messages, "", callbacks);
  } catch (error) {
    const thrown = error instanceof Error ? error : new Error(String(error));
    expect(reported).toBe(thrown);
    return thrown;
  }
  return reported;
}

describe("iteration budget", () => {
  test("exhaustion reports a distinct error type", async () => {
    process.env.WOOPCODE_MAX_ITERATIONS = "2";

    const error = await runToExhaustion();
    expect(error).toBeInstanceOf(IterationBudgetExhaustedError);
  });

  // The message must state the limit that was actually applied, otherwise a
  // raised budget looks like it had no effect.
  test("the error names the configured limit", async () => {
    process.env.WOOPCODE_MAX_ITERATIONS = "3";

    const error = await runToExhaustion();
    expect(error?.message).toContain("(3)");
    expect(error?.message).toContain("WOOPCODE_MAX_ITERATIONS");
  });

  test("an unset budget uses the interactive default", async () => {
    delete process.env.WOOPCODE_MAX_ITERATIONS;

    const error = await runToExhaustion();
    expect(error?.message).toContain("(40)");
  });

  test("a non-numeric budget falls back to the default", async () => {
    process.env.WOOPCODE_MAX_ITERATIONS = "many";

    const error = await runToExhaustion();
    expect(error?.message).toContain("(40)");
  });

  test("a non-positive budget falls back to the default", async () => {
    process.env.WOOPCODE_MAX_ITERATIONS = "0";

    const error = await runToExhaustion();
    expect(error?.message).toContain("(40)");
  });
});

/**
 * The warning has to reach the model, not just the terminal.
 *
 * A benchmark trial made its final write at step 198 of a 200-iteration budget:
 * it was still starting new work at the wall, because the only notice went to
 * stderr through onStatus. The model cannot act on something it was never sent.
 */
/** The nudge pushed into the conversation as the ceiling comes into view. */
const budgetNotices = (messages: Array<{ role: string; content?: string }>) =>
  messages.filter(
    (message) =>
      message.role === "user" &&
      (message.content ?? "").includes("before this turn is stopped"),
  );

describe("running out of budget", () => {
  /** Runs to exhaustion, keeping the transcript and the statuses. */
  async function runKeepingMessages() {
    const { callbacks, messages } = createRuntimeTest();
    callbacks.onError = () => {};

    try {
      await agentLoop(neverFinishingProvider(), messages, "", callbacks);
    } catch {
      // Exhaustion is the expected end; the transcript is what is under test.
    }
    return { messages, callbacks };
  }

  test("the model is told, and only the model", async () => {
    process.env.WOOPCODE_MAX_ITERATIONS = "8";

    const { messages, callbacks } = await runKeepingMessages();

    expect(budgetNotices(messages)).toHaveLength(1);
    // The status used to fire too, back when reaching the ceiling ended the
    // turn as a failure and this row was the user's only warning. The ceiling
    // asks them directly now, so a transcript row saying the turn is nearly
    // over is a worse version of the question they are about to be asked.
    const statuses = callbacks
      .getCallsByName("onStatus")
      .map((call: { args: any[] }) => String(call.args[0]));
    expect(statuses.some((text) => text.includes("iterations remaining"))).toBe(
      false,
    );
  });

  test("the notice names how many steps are left", async () => {
    process.env.WOOPCODE_MAX_ITERATIONS = "8";

    const { messages } = await runKeepingMessages();

    // Fired at iteration 3 of 8, so five remain.
    expect(budgetNotices(messages)[0]!.content).toContain("Only 5 more steps");
  });

  test("a budget too small to warn in still runs and still ends", async () => {
    // The threshold is five from the end, so a budget of two never reaches it.
    // The turn must still exhaust cleanly rather than warn about a negative
    // number of remaining steps.
    process.env.WOOPCODE_MAX_ITERATIONS = "2";

    const { messages } = await runKeepingMessages();
    expect(budgetNotices(messages)).toHaveLength(0);
  });
});

/**
 * Reaching the ceiling asks rather than fails.
 *
 * The distinction that matters here is between "the user said stop" and "there
 * was nobody to ask". They look the same from inside the loop and mean opposite
 * things: one is a turn a human ended, the other is a headless run whose exit
 * code a harness reads. An absent callback is the second, and must keep
 * throwing however the first behaves.
 */
describe("the budget checkpoint", () => {
  /** Runs to exhaustion with a handler, capturing what the loop did. */
  async function runWithHandler(
    onBudgetExhausted: AgentCallbacks["onBudgetExhausted"],
  ) {
    const { callbacks, messages } = createRuntimeTest();
    callbacks.onError = () => {};
    callbacks.onBudgetExhausted = onBudgetExhausted;

    let threw: unknown;
    try {
      await agentLoop(neverFinishingProvider(), messages, "", callbacks);
    } catch (error) {
      threw = error;
    }
    return { threw, callbacks, messages };
  }

  test("with nobody to ask, exhaustion is still an error", async () => {
    process.env.WOOPCODE_MAX_ITERATIONS = "2";

    // No handler at all — the headless case, whose exit code depends on this.
    const error = await runToExhaustion();
    expect(error).toBeInstanceOf(IterationBudgetExhaustedError);
  });

  test("continuing carries the same turn past the original ceiling", async () => {
    process.env.WOOPCODE_MAX_ITERATIONS = "8";

    let asked = 0;
    const { messages } = await runWithHandler(async () => {
      asked += 1;
      // Continue once, then stop, so the test ends rather than looping forever.
      return asked === 1 ? "continue" : "stop";
    });

    expect(asked).toBe(2);
    // Once for the first eight steps, once for the eight the checkpoint added.
    // The warning tracking the extension is how the model learns the second
    // stretch is also finite.
    expect(budgetNotices(messages)).toHaveLength(2);
  });

  test("the handler is told how many steps have been taken", async () => {
    process.env.WOOPCODE_MAX_ITERATIONS = "3";

    const seen: number[] = [];
    await runWithHandler(async ({ steps }) => {
      seen.push(steps);
      return seen.length === 1 ? "continue" : "stop";
    });

    expect(seen).toEqual([3, 6]);
  });

  test("stopping ends the turn as a cancellation, not a failure", async () => {
    process.env.WOOPCODE_MAX_ITERATIONS = "2";

    const { threw, callbacks } = await runWithHandler(async () => "stop");

    // Nothing thrown is the point: the controller marks a turn `error` from a
    // raised exception, and this turn did not fail — it was halted.
    expect(threw).toBeUndefined();
    expect(callbacks.getCallsByName("onCancel")).toHaveLength(1);
    expect(callbacks.getCallsByName("onError")).toHaveLength(0);
  });
});
