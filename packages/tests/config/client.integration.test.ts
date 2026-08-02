import { describe, expect, test } from "bun:test";
import { Type } from "@google/genai";
import { geminiClient } from "../../../config/client";
import type { Message, StreamEvent } from "../../../config/types";

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
