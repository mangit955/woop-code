import { describe, expect, test } from "bun:test";
import { Type } from "@google/genai";
import { geminiClient, thinkingBudget } from "../../../config/client";
import type { Message, StreamEvent } from "../../../config/types";

describe("thinking budget", () => {
  test("defaults to letting the model decide", () => {
    // -1 is AUTOMATIC. A token count here would be a guess about a model the
    // caller may have overridden anyway.
    expect(thinkingBudget({})).toBe(-1);
  });

  test("WOOPCODE_THINKING_BUDGET sets it", () => {
    expect(thinkingBudget({ WOOPCODE_THINKING_BUDGET: "2048" })).toBe(2048);
  });

  test("zero is passed through, not read as unset", () => {
    // Whether 0 means anything is the model's business: gemini-3.5-flash-lite
    // rejects it with a 400, others disable thinking on it. Either way the
    // resolver must not quietly turn it into the default, which would hide the
    // caller's request behind an unrelated value.
    expect(thinkingBudget({ WOOPCODE_THINKING_BUDGET: "0" })).toBe(0);
  });

  test("a nonsense value falls back rather than disabling thinking", () => {
    expect(thinkingBudget({ WOOPCODE_THINKING_BUDGET: "lots" })).toBe(-1);
    expect(thinkingBudget({ WOOPCODE_THINKING_BUDGET: "-5" })).toBe(-1);
  });

  test("off means send no thinking config at all", () => {
    // The only portable way back to the pre-thinking request: gemini-3.5-flash-lite
    // rejects a budget of 0, so "disable" cannot be expressed as a number.
    expect(thinkingBudget({ WOOPCODE_THINKING_BUDGET: "off" })).toBeUndefined();
    expect(thinkingBudget({ WOOPCODE_THINKING_BUDGET: "OFF" })).toBeUndefined();
    expect(thinkingBudget({ WOOPCODE_THINKING_BUDGET: " off " })).toBeUndefined();
  });
});

describe("Gemini provider adapter", () => {
  test("serializes tool schemas and preserves every function call in a chunk", async () => {
    let request: any;
    const ai = {
      models: {
        async generateContentStream(value: unknown) {
          request = value;
          return (async function* () {
            yield {
              candidates: [{
                content: {
                  parts: [
                    { functionCall: { id: "call-1", name: "read_file", args: { path: "README.md" } } },
                    { functionCall: { id: "call-2", name: "ask_user", args: { questions: ["Continue?"] } } },
                  ],
                },
              }],
            };
          })();
        },
      },
    };
    const messages: Message[] = [{ role: "user", content: "Inspect the project" }];
    const events: StreamEvent[] = [];

    for await (const event of geminiClient("test-key", "test-model", ai as any).stream(messages, "repo")) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "tool_call")).toMatchObject([
      { id: "call-1", name: "read_file", arguments: { path: "README.md" } },
      { id: "call-2", name: "ask_user", arguments: { questions: ["Continue?"] } },
    ]);

    const declarations = request.config.tools[0].functionDeclarations;
    const askUser = declarations.find((tool: { name: string }) => tool.name === "ask_user");
    expect(askUser.parameters.properties.questions).toMatchObject({
      type: Type.ARRAY,
      items: { type: Type.STRING },
    });
  });

  /**
   * Usage accumulates across chunks, and only the last report is complete: an
   * early chunk carries the token count of a partial response. Taking the first
   * one would under-report every streamed turn.
   */
  test("reports the final chunk's token usage on the done event", async () => {
    const ai = {
      models: {
        async generateContentStream() {
          return (async function* () {
            yield {
              candidates: [{ content: { parts: [{ text: "Look" }] } }],
              usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 2, totalTokenCount: 1202 },
            };
            yield {
              candidates: [{ content: { parts: [{ text: "ing" }] } }],
              usageMetadata: {
                promptTokenCount: 1200,
                candidatesTokenCount: 5,
                cachedContentTokenCount: 900,
                totalTokenCount: 1205,
              },
            };
          })();
        },
      },
    };
    const messages: Message[] = [{ role: "user", content: "Inspect the project" }];
    const events: StreamEvent[] = [];

    for await (const event of geminiClient("test-key", "test-model", ai as any).stream(messages, "repo")) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({
      type: "done",
      usage: {
        promptTokens: 1200,
        completionTokens: 5,
        cachedTokens: 900,
        totalTokens: 1205,
      },
    });
  });

  /**
   * Tier 1: a request that fails before yielding anything is safe to repeat,
   * because nothing has been observed. This is the case that lost three
   * benchmark trials to one four-second network event.
   */
  test("a transient failure before any output is retried", async () => {
    let calls = 0;
    const ai = {
      models: {
        async generateContentStream() {
          calls++;
          if (calls < 3) {
            throw new Error("The socket connection was closed unexpectedly.");
          }
          return (async function* () {
            yield { candidates: [{ content: { parts: [{ text: "recovered" }] } }] };
          })();
        },
      },
    };

    const events: StreamEvent[] = [];
    for await (const event of geminiClient("k", "m", ai as any).stream(
      [{ role: "user", content: "hi" }],
      "",
    )) {
      events.push(event);
    }

    expect(calls).toBe(3);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(2);
    expect(events.filter((e) => e.type === "text")).toEqual([
      { type: "text", content: "recovered" },
    ]);
    expect(events.at(-1)!.type).toBe("done");
  });

  test("retry events carry what failed and how long the wait is", async () => {
    const ai = {
      models: {
        async generateContentStream() {
          throw new Error("The socket connection was closed unexpectedly.");
        },
      },
    };

    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of geminiClient("k", "m", ai as any).stream(
          [{ role: "user", content: "hi" }],
          "",
        )) {
          events.push(event);
        }
      })(),
    ).rejects.toThrow(/socket connection/);

    // Exhausting the attempts still surfaces the failure; it is not swallowed.
    const retries = events.filter((e) => e.type === "retry");
    expect(retries.length).toBeGreaterThan(0);
    expect(retries[0]).toMatchObject({
      attempt: 1,
      reason: "transient failure",
      error: expect.stringContaining("socket connection"),
    });
  });

  test("a fatal failure is not retried", async () => {
    let calls = 0;
    const ai = {
      models: {
        async generateContentStream() {
          calls++;
          throw Object.assign(new Error("API key not valid"), { status: 400 });
        },
      },
    };

    await expect(
      (async () => {
        for await (const _ of geminiClient("k", "m", ai as any).stream(
          [{ role: "user", content: "hi" }],
          "",
        )) {
          // drain
        }
      })(),
    ).rejects.toThrow(/API key not valid/);

    expect(calls).toBe(1);
  });

  /**
   * Tier 1 stops at the first chunk. After that the caller has already appended
   * the text and printed it, so repeating the request would duplicate output the
   * user watched arrive. Salvaging a partial stream is the loop's job.
   */
  test("a failure after output has streamed is not retried", async () => {
    let calls = 0;
    const ai = {
      models: {
        async generateContentStream() {
          calls++;
          return (async function* () {
            yield { candidates: [{ content: { parts: [{ text: "partial" }] } }] };
            throw new Error("The socket connection was closed unexpectedly.");
          })();
        },
      },
    };

    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of geminiClient("k", "m", ai as any).stream(
          [{ role: "user", content: "hi" }],
          "",
        )) {
          events.push(event);
        }
      })(),
    ).rejects.toThrow(/socket connection/);

    expect(calls).toBe(1);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(0);
    expect(events.filter((e) => e.type === "text")).toHaveLength(1);
  });

  test("a cancelled turn is never retried", async () => {
    const controller = new AbortController();
    let calls = 0;
    const ai = {
      models: {
        async generateContentStream() {
          calls++;
          controller.abort();
          throw new Error("The socket connection was closed unexpectedly.");
        },
      },
    };

    await expect(
      (async () => {
        for await (const _ of geminiClient("k", "m", ai as any).stream(
          [{ role: "user", content: "hi" }],
          "",
          controller.signal,
        )) {
          // drain
        }
      })(),
    ).rejects.toThrow();

    expect(calls).toBe(1);
  });

  test("omits usage entirely when the provider reports none", async () => {
    const ai = {
      models: {
        async generateContentStream() {
          return (async function* () {
            yield { candidates: [{ content: { parts: [{ text: "hi" }] } }] };
          })();
        },
      },
    };
    const events: StreamEvent[] = [];

    for await (const event of geminiClient("test-key", "test-model", ai as any).stream(
      [{ role: "user", content: "hi" }],
      "",
    )) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "done", usage: undefined });
  });
});
