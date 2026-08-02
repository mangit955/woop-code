import { describe, test, expect, mock } from "bun:test";
import { agentLoop } from "../../../config/runtime";
import { toolEffect } from "../../../runtime/toolEffects";
import { toolRegistery } from "../../../tools";
import { MockTool, MockToolRegistry } from "../shared/mocks";
import { createRuntimeTest, createStreamingProvider } from "../shared/testHelpers";
import {
  createDoneEvent,
  createTextEvent,
  createToolCallEvent,
} from "../shared/factories";
import type { TurnSummary } from "../../../config/types";

const mockToolRegistry = new MockToolRegistry();
const getTool = mock((name: string) => mockToolRegistry.get(name));
const actualTools = await import("../../../tools");
mock.module("../../../tools", () => ({ ...actualTools, getTool }));

function summaryOf(callbacks: {
  getCallsByName(name: string): Array<{ args: any[] }>;
}): TurnSummary {
  const calls = callbacks.getCallsByName("onTurnSummary");
  expect(calls.length).toBe(1);
  return calls[0]!.args[0] as TurnSummary;
}

/** Registers a tool that succeeds, replacing any previous one of that name. */
function registerTool(name: string, output = "ok") {
  mockToolRegistry.register(new MockTool(name, output));
}

describe("tool effect classification", () => {
  test("classifies every registered tool", () => {
    const unclassified = toolRegistery
      .map((tool) => tool.name)
      .filter((name) => toolEffect(name) === "unclassified");

    // A new tool that nobody classified would otherwise be silently treated as
    // neither a workspace change nor a verification.
    expect(unclassified).toEqual([]);
  });
});

describe("agentLoop - turn summary", () => {
  test("reports no unverified edits when the turn only read files", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("read_file", "contents");

    const provider = createStreamingProvider([
      [createToolCallEvent("read_file", { path: "a.ts" }, "c1"), createDoneEvent()],
      [createTextEvent("done"), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    const summary = summaryOf(callbacks);
    expect(summary.unverifiedEdits).toBe(false);
    expect(summary.lastWriteStep).toBeUndefined();
    expect(summary.toolCounts).toEqual({ read_file: 1 });
  });

  test("flags an edit that no command followed", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("edit_file", "Edit applied");

    const provider = createStreamingProvider([
      [createToolCallEvent("edit_file", { path: "a.ts" }, "c1"), createDoneEvent()],
      [createTextEvent("Fixed it."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    const summary = summaryOf(callbacks);
    expect(summary.unverifiedEdits).toBe(true);
    expect(summary.lastWriteStep).toBe(1);
    expect(summary.lastShellStep).toBeUndefined();
  });

  test("clears the flag when tests run after the edit", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("edit_file", "Edit applied");
    registerTool("run_tests", "1 pass 0 fail");

    const provider = createStreamingProvider([
      [createToolCallEvent("edit_file", { path: "a.ts" }, "c1"), createDoneEvent()],
      [createToolCallEvent("run_tests", { command: "bun test" }, "c2"), createDoneEvent()],
      [createTextEvent("Fixed and verified."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    const summary = summaryOf(callbacks);
    expect(summary.unverifiedEdits).toBe(false);
    expect(summary.lastWriteStep).toBe(1);
    expect(summary.lastShellStep).toBe(2);
  });

  test("flags tests that ran before the final edit, not after", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("edit_file", "Edit applied");
    registerTool("run_tests", "1 fail");

    const provider = createStreamingProvider([
      [createToolCallEvent("run_tests", { command: "bun test" }, "c1"), createDoneEvent()],
      [createToolCallEvent("edit_file", { path: "a.ts" }, "c2"), createDoneEvent()],
      [createTextEvent("Should be fixed."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    // The ordering is the entire point: verifying and then editing leaves the
    // edit unverified.
    expect(summaryOf(callbacks).unverifiedEdits).toBe(true);
  });

  test("does not count an edit that failed as a workspace change", async () => {
    const { callbacks, messages } = createRuntimeTest();
    const failing = new MockTool("edit_file", "");
    failing.execute = async () => {
      throw new Error("oldText not found");
    };
    mockToolRegistry.register(failing);

    const provider = createStreamingProvider([
      [createToolCallEvent("edit_file", { path: "a.ts" }, "c1"), createDoneEvent()],
      [createTextEvent("Could not apply."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    const summary = summaryOf(callbacks);
    expect(summary.unverifiedEdits).toBe(false);
    expect(summary.lastWriteStep).toBeUndefined();
    expect(summary.toolCounts).toEqual({});
  });

  test("does not count a rejected edit as a workspace change", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("edit_file", "Edit rejected by user");

    const provider = createStreamingProvider([
      [createToolCallEvent("edit_file", { path: "a.ts" }, "c1"), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    // The turn returns early on a rejection; the file is unchanged, so there is
    // nothing left unverified.
    const summary = summaryOf(callbacks);
    expect(summary.lastWriteStep).toBeUndefined();
    expect(summary.unverifiedEdits).toBe(false);
  });

  test("reports exactly once when the iteration budget is exhausted", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("edit_file", "Edit applied");

    const iterations = Array.from({ length: 40 }, () => [
      createToolCallEvent("edit_file", { path: `f${Math.random()}.ts` }, "c1"),
      createDoneEvent(),
    ]);

    await expect(
      agentLoop(createStreamingProvider(iterations), messages, "", callbacks),
    ).rejects.toThrow(/maximum number of iterations/);

    const summary = summaryOf(callbacks);
    expect(summary.unverifiedEdits).toBe(true);
    expect(summary.iterations).toBeGreaterThan(0);
  });

  test("reports once when the turn is cancelled", async () => {
    const { provider, callbacks, messages } = createRuntimeTest();
    const controller = new AbortController();

    provider.setEvents([createTextEvent("partial"), createDoneEvent()]);
    controller.abort();

    await agentLoop(provider, messages, "", callbacks, controller.signal);

    expect(summaryOf(callbacks).unverifiedEdits).toBe(false);
  });
});
