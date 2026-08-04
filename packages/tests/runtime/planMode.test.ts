import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { agentLoop } from "../../../runtime/loop";
import { PLAN_MODE_PROMPT } from "../../../config/systemPrompt";
import type { Message, StreamEvent, Tool, TurnSummary } from "../../../config/types";
import { MockTool, MockToolRegistry, CallbackSpy } from "../shared/mocks";
import {
  createDoneEvent,
  createTextEvent,
  createToolCallEvent,
  createUserMessage,
} from "../shared/factories";

/**
 * The plan-mode gate as the loop actually runs it.
 *
 * `runtime/planMode.test.ts` covers the rules themselves. What is worth proving
 * here is the wiring: that a refused call never reaches `execute`, that the model
 * is told why as a result rather than an exception, and that a refusal is not
 * mistaken for an edit by the turn summary.
 *
 * The module mock is gated per the bun-test skill: `mock.module` is registered
 * for the whole run and cannot be undone, so outside this file's tests the flag
 * is off and lookup delegates to the real registry.
 */
const registry = new MockToolRegistry();
let mockActive = false;
const actualTools = await import("../../../tools");
const realGetTool = actualTools.getTool;

const getTool = mock((name: string) =>
  mockActive ? registry.get(name) : realGetTool(name),
);

mock.module("../../../tools", () => ({ ...actualTools, getTool }));

beforeAll(() => {
  mockActive = true;
});

afterAll(() => {
  mockActive = false;
});

/** Captures what the loop offered the provider, which is the first gate. */
function recordingProvider(iterations: StreamEvent[][]) {
  const offered: (readonly Tool[] | undefined)[] = [];

  return {
    offered,
    async *stream(
      _messages: Message[],
      _repoContext: string,
      _signal?: AbortSignal,
      _useTools?: boolean,
      tools?: readonly Tool[],
    ): AsyncGenerator<StreamEvent> {
      offered.push(tools);
      for (const event of iterations[offered.length - 1] ?? [createDoneEvent()]) {
        yield event;
      }
    },
  };
}

function summaryOf(callbacks: CallbackSpy): TurnSummary {
  const call = callbacks.calls.filter((entry) => entry.name === "onTurnSummary").at(-1);
  return call!.args[0] as TurnSummary;
}

const editCall = createToolCallEvent("edit_file", {
  path: "cli.ts",
  oldText: "a",
  newText: "b",
});

describe("agentLoop in plan mode", () => {
  let edit: MockTool;
  let read: MockTool;
  let terminal: MockTool;

  beforeEach(() => {
    registry.clear();
    edit = new MockTool("edit_file", "Edit applied");
    read = new MockTool("read_file", "file contents");
    terminal = new MockTool("run_terminal", "exit 0");
    registry.register(edit);
    registry.register(read);
    registry.register(terminal);
  });

  test("a writing tool is never executed", async () => {
    const messages: Message[] = [createUserMessage("change cli.ts")];
    const callbacks = new CallbackSpy();
    const provider = recordingProvider([
      [editCall, createDoneEvent()],
      [createTextEvent("Here is the plan instead."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks, undefined, true, {
      planMode: true,
    });

    expect(edit.executionCount).toBe(0);
  });

  test("the refusal reaches the model as a tool result, not as an error", async () => {
    const messages: Message[] = [createUserMessage("change cli.ts")];
    const callbacks = new CallbackSpy();
    const provider = recordingProvider([
      [editCall, createDoneEvent()],
      [createTextEvent("Understood — the plan is…"), createDoneEvent()],
    ]);

    const answer = await agentLoop(provider, messages, "", callbacks, undefined, true, {
      planMode: true,
    });

    const result = messages.find((message) => message.role === "tool");
    expect(result).toBeDefined();
    expect((result as Extract<Message, { role: "tool" }>).content).toContain("plan mode");

    // The turn carried on and answered, rather than dying on the refusal.
    expect(answer).toContain("plan");
    expect(callbacks.calls.some((entry) => entry.name === "onError")).toBe(false);
  });

  test("the refusal is reported as blocked, never as a failure", async () => {
    // A refusal used to arrive on onToolError, which the TUI renders as a red row
    // plus a `failed:` system line — the mode working, dressed as a malfunction.
    const messages: Message[] = [createUserMessage("change cli.ts")];
    const callbacks = new CallbackSpy();
    const provider = recordingProvider([
      [editCall, createDoneEvent()],
      [createTextEvent("Plan follows."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks, undefined, true, { planMode: true });

    const blocked = callbacks.calls.filter((entry) => entry.name === "onToolBlocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.args[0]).toMatchObject({ name: "edit_file" });
    expect(callbacks.calls.some((entry) => entry.name === "onToolError")).toBe(false);
  });

  test("the call and its result stay paired, so the history stays valid", async () => {
    const messages: Message[] = [createUserMessage("change cli.ts")];
    const callbacks = new CallbackSpy();
    const provider = recordingProvider([
      [editCall, createDoneEvent()],
      [createTextEvent("Plan follows."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks, undefined, true, { planMode: true });

    const call = messages.findIndex((message) => message.role === "assistant_tool_call");
    expect(call).toBeGreaterThanOrEqual(0);
    expect(messages[call + 1]?.role).toBe("tool");
  });

  test("a refused write is not counted as an unverified edit", async () => {
    const messages: Message[] = [createUserMessage("change cli.ts")];
    const callbacks = new CallbackSpy();
    const provider = recordingProvider([
      [editCall, createDoneEvent()],
      [createTextEvent("Plan follows."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks, undefined, true, { planMode: true });

    const summary = summaryOf(callbacks);
    expect(summary.unverifiedEdits).toBe(false);
    expect(summary.lastWriteStep).toBeUndefined();
    // Nothing ran, so nothing is owed to the tool count either.
    expect(summary.toolCalls).toBe(0);
  });

  test("the writing tools are withheld from the provider", async () => {
    const messages: Message[] = [createUserMessage("plan a change")];
    const callbacks = new CallbackSpy();
    const provider = recordingProvider([[createTextEvent("Plan."), createDoneEvent()]]);

    await agentLoop(provider, messages, "", callbacks, undefined, true, { planMode: true });

    const names = provider.offered[0]?.map((tool) => tool.name) ?? [];
    expect(names).not.toContain("edit_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("create_file");
    expect(names).toContain("read_file");
    expect(names).toContain("run_terminal");
  });

  test("a writing shell command is refused even though run_terminal is offered", async () => {
    const messages: Message[] = [createUserMessage("edit it with sed")];
    const callbacks = new CallbackSpy();
    const provider = recordingProvider([
      [
        createToolCallEvent("run_terminal", { command: "sed -i 's/a/b/' cli.ts" }),
        createDoneEvent(),
      ],
      [createTextEvent("Plan follows."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks, undefined, true, { planMode: true });

    // The second gate, and the reason the first one is not enough on its own.
    expect(terminal.executionCount).toBe(0);
  });

  test("a read-only shell command still runs", async () => {
    const messages: Message[] = [createUserMessage("look around")];
    const callbacks = new CallbackSpy();
    const provider = recordingProvider([
      [createToolCallEvent("run_terminal", { command: "git status" }), createDoneEvent()],
      [createTextEvent("Plan follows."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks, undefined, true, { planMode: true });

    expect(terminal.executionCount).toBe(1);
  });

  test("reading tools run untouched", async () => {
    const messages: Message[] = [createUserMessage("read cli.ts")];
    const callbacks = new CallbackSpy();
    const provider = recordingProvider([
      [createToolCallEvent("read_file", { path: "cli.ts" }), createDoneEvent()],
      [createTextEvent("Plan follows."), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks, undefined, true, { planMode: true });

    expect(read.executionCount).toBe(1);
  });

  test("repeating a refused call trips the duplicate skip rather than looping", async () => {
    const messages: Message[] = [createUserMessage("change cli.ts")];
    const callbacks = new CallbackSpy();
    const provider = recordingProvider([
      [editCall, createDoneEvent()],
      [editCall, createDoneEvent()],
      [editCall, createDoneEvent()],
      [createTextEvent("Fine — the plan is…"), createDoneEvent()],
    ]);

    await agentLoop(provider, messages, "", callbacks, undefined, true, { planMode: true });

    const results = messages
      .filter((message): message is Extract<Message, { role: "tool" }> => message.role === "tool")
      .map((message) => message.content);

    expect(results).toHaveLength(3);
    expect(results.at(-1)).toContain("Skipped duplicate");
    expect(edit.executionCount).toBe(0);
  });
});

describe("agentLoop in build mode", () => {
  beforeEach(() => {
    registry.clear();
    registry.register(new MockTool("edit_file", "Edit applied"));
  });

  test("writes run, and the whole registry is offered", async () => {
    const messages: Message[] = [createUserMessage("change cli.ts")];
    const callbacks = new CallbackSpy();
    const provider = recordingProvider([
      [editCall, createDoneEvent()],
      [createTextEvent("Done."), createDoneEvent()],
    ]);

    // No options at all: the default has to be Build, or every existing caller
    // silently stops being able to edit.
    await agentLoop(provider, messages, "", callbacks);

    const names = provider.offered[0]?.map((tool) => tool.name) ?? [];
    expect(names).toContain("edit_file");
    expect(names).toContain("write_file");

    const result = messages.find((message) => message.role === "tool");
    expect((result as Extract<Message, { role: "tool" }>).content).toBe("Edit applied");
  });

  test("plan mode's instructions are not sent", async () => {
    const messages: Message[] = [createUserMessage("hello")];
    const callbacks = new CallbackSpy();
    const sent: string[] = [];

    const provider = {
      async *stream(
        _messages: Message[],
        repoContext: string,
      ): AsyncGenerator<StreamEvent> {
        sent.push(repoContext);
        yield createTextEvent("Hi");
        yield createDoneEvent();
      },
    };

    await agentLoop(provider, messages, { repository: "REPO" }, callbacks);

    expect(sent[0]).toBe("REPO");
    expect(sent[0]).not.toContain(PLAN_MODE_PROMPT.trim());
  });
});
