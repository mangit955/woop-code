import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { Message, ProviderClient, StreamEvent } from "../../../config/types";
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

describe("efficiency warning counts tools, not iterations", () => {
  let callbackSpy: CallbackSpy;
  let messages: Message[];

  beforeEach(() => {
    callbackSpy = new CallbackSpy();
    messages = [createUserMessage("Hello")];
    mockToolRegistry.clear();
    mockToolRegistry.register(new MockTool("read_file", "contents"));
  });

  test("fires on the sixth tool even when they arrive in one response", async () => {
    // The old counter would report "1 tool used" here.
    const client = new ScriptedClient([toolCalls(6)]);

    await agentLoop(client, messages, "", callbackSpy);

    const notices = warnings(callbackSpy).filter((text) => text.includes("tools used"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("6 tools used");
  });

  test("does not fire when the sixth response ran no tool", async () => {
    // Five tool calls, then the model answers. The old counter warned "6 tools
    // used" at the start of the sixth iteration, before any sixth tool existed.
    const client = new ScriptedClient([
      toolCalls(1, 0),
      toolCalls(1, 1),
      toolCalls(1, 2),
      toolCalls(1, 3),
      toolCalls(1, 4),
      [createTextEvent("finished"), createDoneEvent()],
    ]);

    await agentLoop(client, messages, "", callbackSpy);

    expect(warnings(callbackSpy).filter((text) => text.includes("tools used"))).toHaveLength(0);
  });

  test("counts tools across iterations and reports the running total", async () => {
    const client = new ScriptedClient([
      toolCalls(4, 0),
      toolCalls(3, 4),
      [createTextEvent("finished"), createDoneEvent()],
    ]);

    await agentLoop(client, messages, "", callbackSpy);

    const notices = warnings(callbackSpy).filter((text) => text.includes("tools used"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("7 tools used");
  });

  test("reports at most once per turn", async () => {
    const client = new ScriptedClient([
      toolCalls(6, 0),
      toolCalls(6, 6),
      [createTextEvent("finished"), createDoneEvent()],
    ]);

    await agentLoop(client, messages, "", callbackSpy);

    expect(warnings(callbackSpy).filter((text) => text.includes("tools used"))).toHaveLength(1);
  });

  test("skipped duplicate calls do not count as tools used", async () => {
    // Eight identical calls: four run, the rest are skipped by the duplicate
    // guard, so the total stays below the warning threshold.
    const repeated: StreamEvent[] = [
      ...Array.from({ length: 8 }, (_, index) =>
        createToolCallEvent("read_file", { path: "same.ts" }, `call-${index}`),
      ),
      createDoneEvent(),
    ];
    const client = new ScriptedClient([repeated, [createTextEvent("finished"), createDoneEvent()]]);

    await agentLoop(client, messages, "", callbackSpy);

    expect(warnings(callbackSpy).filter((text) => text.includes("tools used"))).toHaveLength(0);
  });

  test("the iteration-budget notice still tracks iterations", async () => {
    // Fifteen tool-calling responses reach the iteration milestone.
    const client = new ScriptedClient(
      Array.from({ length: 15 }, (_, index) => toolCalls(1, index)),
    );

    await agentLoop(client, messages, "", callbackSpy);

    const notices = warnings(callbackSpy).filter((text) => text.includes("iterations remaining"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("5 iterations remaining");
  });
});
