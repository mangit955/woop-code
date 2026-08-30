/**
 * Everything a turn records about its own work, and the gates that read it:
 * effect classification, the summary, the verification reminder, and the two
 * finish gates meeting on one response.
 *
 * Four concerns in one file, deliberately. `mock.module` lasts the whole run and
 * the last registration of a module wins for every file, so the tool registry is
 * mocked in as few places as possible — splitting these out would mean a second
 * file stubbing `../../../tools`, and whichever registered last would hand its
 * registry to the other. The cases that need no tool live in
 * `requirementGate.test.ts` and `taskPin.test.ts` for the same reason.
 */
import { describe, test, expect, mock, afterEach } from "bun:test";
import { agentLoop } from "../../../runtime/loop";
import { clearDeadline } from "../../../runtime/deadline";
import { budgetDrivenBy } from "../shared/deadline";
import { toolEffect } from "../../../runtime/toolEffects";
import { toolRegistry } from "../../../tools";
import { MockTool, MockToolRegistry } from "../shared/mocks";
import {
  createRuntimeTest,
  createStreamingProvider,
  turnSummaryOf as summaryOf,
} from "../shared/testHelpers";
import {
  createDoneEvent,
  createTextEvent,
  createToolCallEvent,
} from "../shared/factories";
import type { Message } from "../../../config/types";

const mockToolRegistry = new MockToolRegistry();
const getTool = mock((name: string) => mockToolRegistry.get(name));
const actualTools = await import("../../../tools");
mock.module("../../../tools", () => ({ ...actualTools, getTool }));

/** Registers a tool that succeeds, replacing any previous one of that name. */
function registerTool(name: string, output = "ok") {
  mockToolRegistry.register(new MockTool(name, output));
}

const ORIGINAL_WALL = process.env.WOOPCODE_MAX_WALL_SEC;

afterEach(() => {
  if (ORIGINAL_WALL === undefined) delete process.env.WOOPCODE_MAX_WALL_SEC;
  else process.env.WOOPCODE_MAX_WALL_SEC = ORIGINAL_WALL;

  // Module state outlives a test. The clock goes back with the deadline: a fake
  // one left installed would freeze elapsed time for every file that runs after
  // this one.
  clearDeadline();
});

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

  /**
   * The reminder costs a round trip, and a round trip has to be affordable.
   *
   * Iterations are not the binding budget here — 38 of 40 are left — but the
   * request that produced the answer spent the last of the clock. Injecting
   * anyway sends the loop round to a deadline check that throws, and a turn
   * holding a finished answer exits as `WallBudgetExhaustedError` with status
   * 2. The guard this covers reads both budgets; the one it replaced read only
   * the iteration count, so the case was reachable on every wall-budgeted run.
   */
  test("the reminder is withheld when the clock has nothing left", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("edit_file", "Edit applied");

    // An hour of iterations and a second and a half of clock.
    const clock = budgetDrivenBy(3600, 1_500);

    let n = 0;
    const provider = {
      async *stream() {
        // Each request costs a second of the 1.5 remaining, so the second one
        // ends past the deadline — the shape of a turn whose final answer
        // arrived on the last of its time.
        clock.advance(1_000);
        if (n++ === 0) {
          yield createToolCallEvent("edit_file", { path: "a.ts" }, "c1");
          yield createDoneEvent();
          return;
        }
        yield createTextEvent("Fixed.");
        yield createDoneEvent();
      },
    } as any;

    const result = await agentLoop(provider, messages, "", callbacks);

    expect(result).toBe("Fixed.");
    expect(summaryOf(callbacks).verificationReminders).toBe(0);
    // Still recorded as unverified: the turn is not being told this was fine,
    // only that there was no time left to ask about it.
    expect(summaryOf(callbacks).unverifiedEdits).toBe(true);
  });
});

describe("both finish gates on one response", () => {
  /** The two gates' messages, by their openings. */
  const asks = (messages: Message[], opening: string) =>
    messages.filter((m) => m.role === "user" && m.content.includes(opening));

  const VERIFY_OPENING = "have not run anything";
  const REQUIREMENT_OPENING = "go back to the task statement above";

  /** Edit something, then declare victory without running anything. */
  const editThenClaim = () =>
    createStreamingProvider([
      [createToolCallEvent("edit_file", { path: "a.ts" }, "c1"), createDoneEvent()],
      [createTextEvent("All done."), createDoneEvent()],
    ]);

  test("an unattended turn that edited blindly gets one message, not two", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("edit_file", "Edit applied");

    await agentLoop(editThenClaim(), messages, "", callbacks, undefined, true, {
      unattended: true,
    });

    // One user message carrying both asks. A second injection would cost
    // another of the six turns the window keeps, which is the scarce resource
    // on the long turns this gate fires in.
    const injected = messages.filter(
      (m): m is Extract<Message, { role: "user" }> =>
        m.role === "user" &&
        (m.content.includes(VERIFY_OPENING) || m.content.includes(REQUIREMENT_OPENING)),
    );
    expect(injected).toHaveLength(1);
    expect(injected[0]!.content).toContain(VERIFY_OPENING);
    expect(injected[0]!.content).toContain(REQUIREMENT_OPENING);

    const summary = summaryOf(callbacks);
    expect(summary.verificationReminders).toBe(1);
    expect(summary.requirementReminders).toBe(1);

    // The live channel names both. One message reaches the model, but this is
    // what a headless operator watches on stderr and what lands in the event
    // log — a turn where both gates fired must not read as one where only the
    // verification gate did.
    const statuses = callbacks
      .getCallsByName("onStatus")
      .map((call) => String(call.args[0]));
    const notice = statuses.find((status) => status.includes("asking the agent"));
    expect(notice).toContain("files changed without a check");
    expect(notice).toContain("finishing early with budget left");
  });

  test("an attended turn that edited blindly still gets only the verify ask", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("edit_file", "Edit applied");

    await agentLoop(editThenClaim(), messages, "", callbacks);

    expect(asks(messages, VERIFY_OPENING)).toHaveLength(1);
    expect(asks(messages, REQUIREMENT_OPENING)).toHaveLength(0);
  });

  test("a tool run after the gate is recorded as acting on it", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("run_tests", "3 pass 0 fail");

    const provider = createStreamingProvider([
      [createTextEvent("Looks right to me."), createDoneEvent()],
      // The gate landed and the model went and checked.
      [createToolCallEvent("run_tests", { command: "bun test" }, "c1"), createDoneEvent()],
      [createTextEvent("Verified against the stated requirements."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks, undefined, true, {
      unattended: true,
    });

    const summary = summaryOf(callbacks);
    expect(summary.requirementReminders).toBe(1);
    expect(summary.requirementGateActedOn).toBe(true);
  });

  /**
   * The gate demands output the duplicate threshold would refuse.
   *
   * `overfull-hbox` ran its chosen check three times and still scored zero. Told
   * to prove a requirement it cannot prove, the model's next move is very often
   * that same command — which `executeToolCall` answers with "the result for
   * these exact arguments is already in the conversation", pointing at output
   * the window dropped long ago. So the gate clears the ledger as it fires.
   */
  test("a repeat of an already-exhausted command runs again after the gate", async () => {
    const { callbacks, messages } = createRuntimeTest();
    registerTool("run_terminal", "no overfull boxes found");

    const check = { command: "pdflatex doc.tex | grep -i overfull" };
    const provider = createStreamingProvider([
      // Twice, which exhausts the threshold, then an answer.
      [createToolCallEvent("run_terminal", check, "c1"), createDoneEvent()],
      [createToolCallEvent("run_terminal", check, "c2"), createDoneEvent()],
      [createTextEvent("No overfull boxes. Done."), createDoneEvent()],
      // After the gate: the same command again, which without the amnesty is
      // skipped as a duplicate and executes nothing.
      [createToolCallEvent("run_terminal", check, "c4"), createDoneEvent()],
      [createTextEvent("Re-checked, with output."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks, undefined, true, {
      unattended: true,
    });

    const summary = summaryOf(callbacks);
    expect(summary.requirementReminders).toBe(1);
    // Three executions, not two: the post-gate repeat actually ran.
    expect(summary.toolCounts.run_terminal).toBe(3);
    expect(summary.requirementGateActedOn).toBe(true);
    expect(
      messages.some(
        (m) => m.role === "tool" && m.content.includes("Skipped duplicate"),
      ),
    ).toBe(false);
  });
});
