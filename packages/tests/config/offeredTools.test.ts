import { describe, test, expect } from "bun:test";
import { Type } from "@google/genai";
import { geminiClient } from "../../../config/client";
import { anthropicClient } from "../../../config/anthropicClient";
import { toolRegistery } from "../../../tools";
import { planModeTools } from "../../../runtime/planMode";
import type { Message, StreamEvent, Tool } from "../../../config/types";
import { fakeAnthropic, textBlock, messageStop } from "../shared/anthropicStream";

/**
 * Plan mode's first gate, at the wire.
 *
 * The loop narrows the tool list and hands it to `stream`. Everything up to that
 * boundary is covered by packages/tests/runtime/planMode.test.ts against a fake
 * provider — which means a client that quietly ignored the argument would leave
 * every one of those tests green while offering the model `edit_file` anyway.
 * This is the assertion that would notice.
 */

const messages: Message[] = [{ role: "user", content: "plan a change" }];

function recordingGemini() {
  const requests: any[] = [];

  return {
    requests,
    ai: {
      models: {
        async generateContentStream(value: unknown) {
          requests.push(value);
          return (async function* () {
            yield { candidates: [{ content: { parts: [{ text: "ok" }] } }] };
          })();
        },
      },
    },
  };
}

async function drainGemini(ai: unknown, tools?: readonly Tool[]) {
  const events: StreamEvent[] = [];
  for await (const event of geminiClient("k", "m", ai as any).stream(
    messages,
    "repo",
    undefined,
    true,
    tools,
  )) {
    events.push(event);
  }
  return events;
}

/** Names of the writing tools, read from the registry rather than hardcoded. */
const writingTools = ["edit_file", "write_file", "create_file"];

describe("Gemini client — the tools it offers", () => {
  test("sends the whole registry when the caller names none", async () => {
    const gemini = recordingGemini();
    await drainGemini(gemini.ai);

    const declared = gemini.requests[0].config.tools[0].functionDeclarations.map(
      (tool: { name: string }) => tool.name,
    );

    expect(declared).toHaveLength(toolRegistery.length);
    for (const name of writingTools) expect(declared).toContain(name);
  });

  test("sends exactly the narrowed list, and no writing tool", async () => {
    const gemini = recordingGemini();
    await drainGemini(gemini.ai, planModeTools(toolRegistery));

    const declared = gemini.requests[0].config.tools[0].functionDeclarations.map(
      (tool: { name: string }) => tool.name,
    );

    expect(declared).toEqual(planModeTools(toolRegistery).map((tool) => tool.name));
    for (const name of writingTools) expect(declared).not.toContain(name);
    expect(declared).toContain("read_file");
    // Kept deliberately: inspection is most of planning, and the command-level
    // gate in the loop is what makes it safe to offer.
    expect(declared).toContain("run_terminal");
  });

  test("an object array parameter reaches the provider as an object array", async () => {
    // todo_write is the reason config/toolSchema.ts exists; both clients used to
    // hardcode `items: { type: STRING }`, which cannot express a status.
    const gemini = recordingGemini();
    await drainGemini(gemini.ai);

    const todo = gemini.requests[0].config.tools[0].functionDeclarations.find(
      (tool: { name: string }) => tool.name === "todo_write",
    );
    const items = todo.parameters.properties.todos.items;

    expect(items.type).toBe(Type.OBJECT);
    expect(items.properties.status.enum).toEqual([
      "pending",
      "in_progress",
      "completed",
    ]);
    expect(items.required).toEqual(["content", "status"]);
  });
});

describe("Anthropic client — the tools it offers", () => {
  async function drainAnthropic(tools?: readonly Tool[]) {
    const fake = fakeAnthropic(() => ({
      events: [...textBlock(0, "ok"), ...messageStop()],
    }));

    for await (const _ of anthropicClient("k", "m", fake.api as never).stream(
      messages,
      "repo",
      undefined,
      true,
      tools,
    )) {
      // drained for the request, not the events
    }

    return fake.requests[0].tools.map((tool: { name: string }) => tool.name);
  }

  test("sends the whole registry when the caller names none", async () => {
    const declared = await drainAnthropic();

    expect(declared).toHaveLength(toolRegistery.length);
    for (const name of writingTools) expect(declared).toContain(name);
  });

  test("sends exactly the narrowed list, and no writing tool", async () => {
    const declared = await drainAnthropic(planModeTools(toolRegistery));

    expect(declared).toEqual(planModeTools(toolRegistery).map((tool) => tool.name));
    for (const name of writingTools) expect(declared).not.toContain(name);
    expect(declared).toContain("run_terminal");
  });
});
