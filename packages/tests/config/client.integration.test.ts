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
});
