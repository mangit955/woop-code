import { describe, test, expect, mock } from "bun:test";
import { agentLoop, measureSegments, renderContext } from "../../../runtime/loop";
import { SYSTEM_PROMPT } from "../../../config/systemPrompt";
import { MockTool, MockToolRegistry } from "../shared/mocks";
import { createRuntimeTest, createStreamingProvider } from "../shared/testHelpers";
import {
  createAssistantMessage,
  createAssistantToolCallMessage,
  createDoneEvent,
  createTextEvent,
  createToolCallEvent,
  createToolMessage,
  createUserMessage,
} from "../shared/factories";
import type { IterationUsage } from "../../../config/types";

const mockToolRegistry = new MockToolRegistry();
const getTool = mock((name: string) => mockToolRegistry.get(name));
const actualTools = await import("../../../tools");
mock.module("../../../tools", () => ({ ...actualTools, getTool }));

/** The usage reports a run produced, in order. */
function usageReports(callbacks: { getCallsByName(name: string): Array<{ args: any[] }> }) {
  return callbacks
    .getCallsByName("onUsage")
    .map((call) => call.args[0] as IterationUsage);
}

describe("measureSegments", () => {
  test("attributes conversation and tool bytes to separate segments", () => {
    const segments = measureSegments(
      [
        createUserMessage("hello"),
        createAssistantMessage("hi"),
        createAssistantToolCallMessage("read_file", "call-1", { path: "a.ts" }),
        createToolMessage("read_file", "call-1", "file contents"),
      ],
      "repo",
    );

    expect(segments.conversation).toBe("hello".length + "hi".length);
    expect(segments.toolResults).toBe(
      JSON.stringify({ path: "a.ts" }).length + "file contents".length,
    );
    expect(segments.repoContext).toBe(4);
    expect(segments.systemPrompt).toBe(SYSTEM_PROMPT.length);
  });

  test("reports zero for an empty conversation", () => {
    const segments = measureSegments([], "");

    expect(segments.conversation).toBe(0);
    expect(segments.toolResults).toBe(0);
    expect(segments.repoContext).toBe(0);
  });
});

describe("agentLoop - usage reporting", () => {
  test("reports one iteration with the provider's token counts", async () => {
    const { provider, callbacks, messages } = createRuntimeTest();

    provider.setEvents([
      createTextEvent("done"),
      createDoneEvent({
        promptTokens: 1200,
        completionTokens: 40,
        cachedTokens: 800,
        totalTokens: 1240,
      }),
    ]);

    await agentLoop(provider, messages, "repo context", callbacks);

    const reports = usageReports(callbacks);
    expect(reports.length).toBe(1);
    expect(reports[0]!.iteration).toBe(1);
    expect(reports[0]!.usage).toEqual({
      promptTokens: 1200,
      completionTokens: 40,
      cachedTokens: 800,
      totalTokens: 1240,
    });
    expect(reports[0]!.toolCalls).toBe(0);
    expect(reports[0]!.segments.repoContext).toBe("repo context".length);
    expect(reports[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("leaves usage undefined when the provider reports none", async () => {
    const { provider, callbacks, messages } = createRuntimeTest();

    provider.setEvents([createTextEvent("done"), createDoneEvent()]);

    await agentLoop(provider, messages, "", callbacks);

    const reports = usageReports(callbacks);
    expect(reports.length).toBe(1);
    // Absent, never zero: a missing count must stay visibly missing.
    expect(reports[0]!.usage).toBeUndefined();
  });

  test("reports every iteration, counting the tool calls each requested", async () => {
    const { callbacks, messages } = createRuntimeTest();
    mockToolRegistry.register(new MockTool("read_file", "contents"));

    const provider = createStreamingProvider([
      [
        createToolCallEvent("read_file", { path: "a.ts" }, "call-1"),
        createToolCallEvent("read_file", { path: "b.ts" }, "call-2"),
        createDoneEvent({ promptTokens: 100 }),
      ],
      [createTextEvent("finished"), createDoneEvent({ promptTokens: 900 })],
    ]);

    await agentLoop(provider, messages, "", callbacks);

    const reports = usageReports(callbacks);
    expect(reports.map((report) => report.iteration)).toEqual([1, 2]);
    expect(reports.map((report) => report.toolCalls)).toEqual([2, 0]);

    // The tool results of iteration 1 are in the prompt of iteration 2, so the
    // segment split has to show them arriving.
    expect(reports[0]!.segments.toolResults).toBe(0);
    expect(reports[1]!.segments.toolResults).toBeGreaterThan(0);
  });

  test("reports nothing for an iteration the user cancelled", async () => {
    const { provider, callbacks, messages } = createRuntimeTest();
    const controller = new AbortController();

    provider.setEvents([createTextEvent("partial"), createDoneEvent()]);
    controller.abort();

    await agentLoop(provider, messages, "", callbacks, controller.signal);

    expect(usageReports(callbacks).length).toBe(0);
    expect(callbacks.getCallsByName("onCancel").length).toBe(1);
  });
});

describe("turn context segments", () => {
  test("a plain string is repository context with no execution log", () => {
    // The form every caller used before the log existed, and the form the
    // replay corpus reconstructs from recordings that predate it.
    const segments = measureSegments([], "repo text");

    expect(segments.repoContext).toBe(9);
    expect(segments.executionLog).toBe(0);
  });

  test("the execution log is measured apart from the repository context", () => {
    // Previously joined into one string before measurement, which reported the
    // log as repository context and made the two indistinguishable.
    const segments = measureSegments([], {
      repository: "repo text",
      executionLog: "did a thing",
    });

    expect(segments.repoContext).toBe(9);
    expect(segments.executionLog).toBe(11);
  });

  test("an absent log measures zero rather than being omitted", () => {
    const segments = measureSegments([], { repository: "repo" });
    expect(segments.executionLog).toBe(0);
  });

  test("the provider still receives one string", () => {
    expect(renderContext({ repository: "repo", executionLog: "log" })).toBe(
      "repo\n\nlog",
    );
  });

  test("rendering omits the separator when a piece is missing", () => {
    // An empty repository context must not leave a leading blank line, and an
    // empty log must not leave a trailing one.
    expect(renderContext({ repository: "repo", executionLog: "" })).toBe("repo");
    expect(renderContext({ repository: "", executionLog: "log" })).toBe("log");
    expect(renderContext("repo")).toBe("repo");
  });

  test("what is measured is what is sent", () => {
    // The join and the measurement must not drift: their sum has to equal the
    // rendered length, or the meter is describing a different request.
    const context = { repository: "repo text", executionLog: "did a thing" };
    const segments = measureSegments([], context);
    const rendered = renderContext(context);

    expect(segments.repoContext + segments.executionLog).toBe(
      rendered.length - 2, // the "\n\n" separator
    );
  });
});
