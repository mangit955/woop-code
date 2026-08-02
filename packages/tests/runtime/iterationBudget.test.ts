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
