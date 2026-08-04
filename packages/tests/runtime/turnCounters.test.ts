import { describe, test, expect, beforeEach, mock } from "bun:test";
import type {
  Message,
  ProviderClient,
  StreamEvent,
  TurnSummary,
} from "../../../config/types";
import { MockTool, MockToolRegistry, CallbackSpy } from "../shared/mocks";
import {
  createUserMessage,
  createTextEvent,
  createToolCallEvent,
  createDoneEvent,
} from "../shared/factories";

const mockToolRegistry = new MockToolRegistry();
const getTool = mock((name: string) => mockToolRegistry.get(name));

// Keep the real registry exports; only tool lookup is faked.
const actualTools = await import("../../../tools");
mock.module("../../../tools", () => ({ ...actualTools, getTool }));

const { agentLoop } = await import("../../../runtime/loop");

/** Replays a different response for each iteration of the loop. */
class ScriptedClient implements ProviderClient {
  constructor(private readonly script: StreamEvent[][]) {}

  private iteration = 0;

  async *stream(): AsyncGenerator<StreamEvent> {
    const events = this.script[this.iteration] ?? [
      createTextEvent("done"),
      createDoneEvent(),
    ];
    this.iteration++;

    for (const event of events) {
      yield event;
    }
  }
}

function toolCalls(count: number, offset = 0): StreamEvent[] {
  return [
    // Distinct arguments so the duplicate-call guard does not interfere.
    ...Array.from({ length: count }, (_, index) =>
      createToolCallEvent("read_file", { path: `file-${offset + index}.ts` }, `call-${offset + index}`),
    ),
    createDoneEvent(),
  ];
}

function warnings(spy: CallbackSpy): string[] {
  return spy
    .getCallsByName("onStatus")
    .map((call) => String(call.args[0]))
    .filter((status) => status.startsWith("⚠️"));
}

function summary(spy: CallbackSpy) {
  const calls = spy.getCallsByName("onTurnSummary");
  return calls.at(-1)?.args[0] as TurnSummary | undefined;
}

/**
 * These used to assert a notice that fired at the sixth tool call. It was
 * removed: unlike the iteration-budget warning it sat beside, it pushed nothing
 * into the conversation, so the advice it gave — start implementing — reached
 * only the user, who is not the one deciding what to call next. What remains
 * are the counters underneath it, which the turn summary still reports.
 */
describe("a turn counts the tools it actually ran", () => {
  let callbackSpy: CallbackSpy;
  let messages: Message[];

  beforeEach(() => {
    callbackSpy = new CallbackSpy();
    messages = [createUserMessage("Hello")];
    mockToolRegistry.clear();
    mockToolRegistry.register(new MockTool("read_file", "contents"));
  });

  test("counts every call in a response, not the response", async () => {
    // Six calls arriving together are six tools run. A counter reading the
    // iteration would call this one.
    const client = new ScriptedClient([toolCalls(6)]);

    await agentLoop(client, messages, "", callbackSpy);

    expect(summary(callbackSpy)?.toolCalls).toBe(6);
  });

  test("accumulates across iterations", async () => {
    const client = new ScriptedClient([
      toolCalls(4, 0),
      toolCalls(3, 4),
      [createTextEvent("finished"), createDoneEvent()],
    ]);

    await agentLoop(client, messages, "", callbackSpy);

    expect(summary(callbackSpy)?.toolCalls).toBe(7);
  });

  test("skipped duplicate calls do not count as tools used", async () => {
    // Eight identical calls. SAME_TOOL_THRESHOLD lets two through and the
    // duplicate guard skips the rest.
    const repeated: StreamEvent[] = [
      ...Array.from({ length: 8 }, (_, index) =>
        createToolCallEvent("read_file", { path: "same.ts" }, `call-${index}`),
      ),
      createDoneEvent(),
    ];
    const client = new ScriptedClient([repeated, [createTextEvent("finished"), createDoneEvent()]]);

    await agentLoop(client, messages, "", callbackSpy);

    // Two ran; the rest never reached a tool, so counting them would report
    // work the turn did not do.
    expect(summary(callbackSpy)?.toolCalls).toBe(2);
  });

  test("the iteration-budget notice reaches the model, not the terminal", async () => {
    // Thirty-five tool-calling responses reach the milestone five from the end
    // of the default budget.
    const client = new ScriptedClient(
      Array.from({ length: 35 }, (_, index) => toolCalls(1, index)),
    );

    await agentLoop(client, messages, "", callbackSpy);

    // It is a nudge for the model — stop starting new work — and the user is
    // asked about the ceiling directly rather than warned about it here. See
    // packages/tests/runtime/iterationBudget.test.ts for both halves.
    expect(warnings(callbackSpy).filter((t) => t.includes("iterations remaining"))).toHaveLength(0);
    expect(
      messages.filter(
        (message) =>
          message.role === "user" &&
          (message.content ?? "").includes("before this turn is stopped"),
      ),
    ).toHaveLength(1);
  });
});
