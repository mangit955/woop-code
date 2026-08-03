import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  agentLoop,
  IterationBudgetExhaustedError,
} from "../../../config/runtime";
import type { ProviderClient, StreamEvent } from "../../../config/types";
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
    expect(error?.message).toContain("(20)");
  });

  test("a non-numeric budget falls back to the default", async () => {
    process.env.WOOPCODE_MAX_ITERATIONS = "many";

    const error = await runToExhaustion();
    expect(error?.message).toContain("(20)");
  });

  test("a non-positive budget falls back to the default", async () => {
    process.env.WOOPCODE_MAX_ITERATIONS = "0";

    const error = await runToExhaustion();
    expect(error?.message).toContain("(20)");
  });
});

/**
 * The warning has to reach the model, not just the terminal.
 *
 * A benchmark trial made its final write at step 198 of a 200-iteration budget:
 * it was still starting new work at the wall, because the only notice went to
 * stderr through onStatus. The model cannot act on something it was never sent.
 */
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

  const budgetNotices = (messages: Array<{ role: string; content?: string }>) =>
    messages.filter(
      (message) =>
        message.role === "user" &&
        (message.content ?? "").includes("before this turn is stopped"),
    );

  test("the model is told, not just the terminal", async () => {
    process.env.WOOPCODE_MAX_ITERATIONS = "8";

    const { messages, callbacks } = await runKeepingMessages();

    expect(budgetNotices(messages)).toHaveLength(1);
    // The status still fires: the TUI shows it, and removing it would trade one
    // audience for the other.
    const statuses = callbacks
      .getCallsByName("onStatus")
      .map((call: { args: any[] }) => String(call.args[0]));
    expect(statuses.some((text) => text.includes("iterations remaining"))).toBe(
      true,
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
