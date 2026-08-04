import { describe, test, expect, mock } from "bun:test";
import { agentLoop } from "../../../runtime/loop";
import { toolEffect } from "../../../runtime/toolEffects";
import { toolRegistry } from "../../../tools";
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
    const unclassified = toolRegistry
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

describe("agentLoop - edits made through the shell", () => {
  test("a sed -i counts as a workspace change, not as verification", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("run_terminal", "");

    const provider = createStreamingProvider([
      [
        createToolCallEvent(
          "run_terminal",
          { command: "sed -i 's/CC =.*/CC = gcc/' unix.mak" },
          "c1",
        ),
        createDoneEvent(),
      ],
      [createTextEvent("Patched the makefile."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    // Before commands were classified by content, this recorded a shell step
    // and reported the turn as verified — the exact opposite of the truth.
    const summary = summaryOf(callbacks);
    expect(summary.lastWriteStep).toBeDefined();
    expect(summary.unverifiedEdits).toBe(true);
  });

  test("a build after a shell edit clears the flag", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("run_terminal", "ok");

    const provider = createStreamingProvider([
      [
        createToolCallEvent("run_terminal", { command: "sed -i 's/a/b/' f.c" }, "c1"),
        createDoneEvent(),
      ],
      [createToolCallEvent("run_terminal", { command: "make -j4" }, "c2"), createDoneEvent()],
      [createTextEvent("Built."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    expect(summaryOf(callbacks).unverifiedEdits).toBe(false);
  });

  test("one command that edits then builds is verified", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("run_terminal", "ok");

    const provider = createStreamingProvider([
      [
        createToolCallEvent(
          "run_terminal",
          { command: "sed -i 's/-O/-O2/' unix.mak && make" },
          "c1",
        ),
        createDoneEvent(),
      ],
      [createTextEvent("Done."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    // The build ran after the edit within the same command, so the ordering
    // has to place the check second.
    const summary = summaryOf(callbacks);
    expect(summary.lastShellStep!).toBeGreaterThan(summary.lastWriteStep!);
    expect(summary.unverifiedEdits).toBe(false);
  });

  test("a read-only command is neither an edit nor a verification", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("run_terminal", "a.ts\nb.ts");

    const provider = createStreamingProvider([
      [createToolCallEvent("run_terminal", { command: "ls -la src" }, "c1"), createDoneEvent()],
      [createTextEvent("Listed."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    const summary = summaryOf(callbacks);
    expect(summary.lastWriteStep).toBeUndefined();
    expect(summary.lastShellStep).toBeUndefined();
    expect(summary.unverifiedEdits).toBe(false);
  });
});

describe("agentLoop - asking the turn to verify its edits", () => {
  test("a turn that edited without checking is asked once", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("edit_file", "Edit applied");
    registerTool("run_tests", "41 pass");

    const contexts: string[] = [];
    let n = 0;
    const provider = {
      async *stream(_m: any, ctx: string) {
        contexts.push(ctx);
        if (n++ === 0) {
          yield createToolCallEvent("edit_file", { path: "a.ts" }, "c1");
          yield createDoneEvent();
          return;
        }
        yield createTextEvent("Fixed.");
        yield createDoneEvent();
      },
    } as any;

    await agentLoop(provider, messages, "repo", callbacks);

    const summary = summaryOf(callbacks);
    expect(summary.verificationReminders).toBe(1);
    // Delivered as a user message: Gemini rejects a request whose last
    // message is from the model, so continuing requires one.
    const injected = messages.filter(
      (m) => m.role === "user" && m.content.includes("have not run anything"),
    );
    expect(injected).toHaveLength(1);
  });

  test("the reminder is dropped after one iteration", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("edit_file", "Edit applied");

    const contexts: string[] = [];
    let n = 0;
    const provider = {
      async *stream(_m: any, ctx: string) {
        contexts.push(ctx);
        if (n++ === 0) {
          yield createToolCallEvent("edit_file", { path: "a.ts" }, "c1");
          yield createDoneEvent();
          return;
        }
        yield createTextEvent("Cannot verify.");
        yield createDoneEvent();
      },
    } as any;

    await agentLoop(provider, messages, "repo", callbacks);

    // Asked once, never twice: the model may have a good reason, and a loop
    // that insists would spend the budget arguing.
    expect(summaryOf(callbacks).verificationReminders).toBe(1);
    expect(
      messages.filter(
        (m) => m.role === "user" && m.content.includes("have not run anything"),
      ),
    ).toHaveLength(1);
  });

  test("a turn that verified is not asked", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("edit_file", "Edit applied");
    registerTool("run_tests", "41 pass");

    const provider = createStreamingProvider([
      [createToolCallEvent("edit_file", { path: "a.ts" }, "c1"), createDoneEvent()],
      [createToolCallEvent("run_tests", { command: "bun test" }, "c2"), createDoneEvent()],
      [createTextEvent("Fixed and verified."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    expect(summaryOf(callbacks).verificationReminders).toBe(0);
  });

  test("a read-only turn is not asked", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("read_file", "contents");

    const provider = createStreamingProvider([
      [createToolCallEvent("read_file", { path: "a.ts" }, "c1"), createDoneEvent()],
      [createTextEvent("Here is what it says."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    // Nothing changed, so there is nothing to verify and no reason to spend an
    // extra iteration asking.
    expect(summaryOf(callbacks).verificationReminders).toBe(0);
  });

  test("an edit made through the shell is asked about too", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("run_terminal", "");

    let n = 0;
    const contexts: string[] = [];
    const provider = {
      async *stream(_m: any, ctx: string) {
        contexts.push(ctx);
        if (n++ === 0) {
          yield createToolCallEvent("run_terminal", { command: "sed -i 's/a/b/' f.c" }, "c1");
          yield createDoneEvent();
          return;
        }
        yield createTextEvent("Patched.");
        yield createDoneEvent();
      },
    } as any;

    await agentLoop(provider, messages, "", callbacks);

    // This is the path the benchmark showed the agent actually using.
    expect(summaryOf(callbacks).verificationReminders).toBe(1);
  });

  test("the turn still ends when the model declines to verify", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("edit_file", "Edit applied");

    let n = 0;
    const provider = {
      async *stream() {
        if (n++ === 0) {
          yield createToolCallEvent("edit_file", { path: "a.ts" }, "c1");
          yield createDoneEvent();
          return;
        }
        yield createTextEvent("No tests exist for this file.");
        yield createDoneEvent();
      },
    } as any;

    const result = await agentLoop(provider, messages, "", callbacks);

    expect(result).toBe("No tests exist for this file.");
    expect(summaryOf(callbacks).unverifiedEdits).toBe(true);
  });
});
