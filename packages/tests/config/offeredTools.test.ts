import { describe, test, expect } from "bun:test";
import { Type } from "@google/genai";
import { geminiClient } from "../../../config/client";
import { anthropicClient } from "../../../config/anthropicClient";
import { openaiClient } from "../../../config/openaiClient";
import { enabledProviderIds } from "../../../config/providerRegistry";
import { toolRegistery } from "../../../tools";
import { planModeTools } from "../../../runtime/planMode";
import { TOOL_EFFECTS } from "../../../runtime/toolEffects";
import type { Message, ProviderClient, Tool } from "../../../config/types";
import { fakeAnthropic, textBlock, messageStop } from "../shared/anthropicStream";
import { fakeOpenAI, textItem } from "../shared/openaiStream";

/**
 * Every provider must send the tool list it was given, not the whole registry.
 *
 * This is plan mode's first gate, and it lives in each client. The loop narrows
 * the list and passes it to `stream`; a client that reads `toolRegistery`
 * directly offers the model `edit_file` while the session is planning, and
 * nothing else in the suite notices — the loop's own tests use a fake provider,
 * so they stay green either way.
 *
 * That is not hypothetical. The OpenAI client shipped ignoring the parameter,
 * because it was branched before the parameter existed and merged after: two
 * green branches, no textual conflict, a gate quietly half-missing on one
 * provider. This file is driven by `enabledProviderIds()` so the next provider
 * cannot repeat it — a client with no entry below fails the coverage test rather
 * than being silently skipped.
 */

const messages: Message[] = [{ role: "user", content: "plan a change" }];

/** Names of the tools that change the workspace, read from the effects table. */
const writingTools = Object.entries(TOOL_EFFECTS)
  .filter(([, effect]) => effect === "write")
  .map(([name]) => name);

interface ProviderProbe {
  /** Builds the client over a recorder, and reports the tools it sent. */
  offeredTo(tools?: readonly Tool[]): Promise<string[]>;
}

/**
 * One entry per enabled provider. Each fakes only the network and reads the tool
 * names back out of the request the client actually built.
 */
const PROBES: Record<string, ProviderProbe> = {
  google: {
    async offeredTo(tools) {
      const requests: any[] = [];
      const ai = {
        models: {
          async generateContentStream(request: unknown) {
            requests.push(request);
            return (async function* () {
              yield { candidates: [{ content: { parts: [{ text: "ok" }] } }] };
            })();
          },
        },
      };

      await drain(geminiClient("k", "m", ai as any), tools);

      return requests[0].config.tools[0].functionDeclarations.map(
        (tool: { name: string }) => tool.name,
      );
    },
  },

  anthropic: {
    async offeredTo(tools) {
      const fake = fakeAnthropic(() => ({
        events: [...textBlock(0, "ok"), ...messageStop()],
      }));

      await drain(anthropicClient("k", "m", fake.api as never), tools);

      return fake.requests[0].tools.map((tool: { name: string }) => tool.name);
    },
  },

  openai: {
    async offeredTo(tools) {
      const fake = fakeOpenAI(() => ({ events: [...textItem(0, "ok")] }));

      await drain(openaiClient("k", "m", fake.api as never), tools);

      return fake.requests[0].tools.map((tool: { name: string }) => tool.name);
    },
  },
};

async function drain(client: ProviderClient, tools?: readonly Tool[]) {
  for await (const _ of client.stream(messages, "repo", undefined, true, tools)) {
    // drained for the request it built, not for the events
  }
}

describe("provider tool lists", () => {
  test("every enabled provider is probed here", () => {
    // The rule, not a formality: a provider added to the registry without an
    // entry above would otherwise be exempt from every assertion below, which is
    // exactly how the OpenAI client shipped with the gate missing.
    expect(Object.keys(PROBES).sort()).toEqual([...enabledProviderIds()].sort());
  });

  test("the effects table lists some writing tools", () => {
    // Guards the guards: with no writing tools, "offers no writing tool" holds
    // vacuously for every provider.
    expect(writingTools.length).toBeGreaterThan(0);
  });

  for (const [provider, probe] of Object.entries(PROBES)) {
    describe(provider, () => {
      test("sends the whole registry when the caller names none", async () => {
        const offered = await probe.offeredTo();

        expect(offered).toHaveLength(toolRegistery.length);
        for (const name of writingTools) expect(offered).toContain(name);
      });

      test("sends exactly the narrowed list", async () => {
        const narrowed = planModeTools(toolRegistery);
        const offered = await probe.offeredTo(narrowed);

        expect(offered).toEqual(narrowed.map((tool) => tool.name));
      });

      test("offers no writing tool while planning", async () => {
        const offered = await probe.offeredTo(planModeTools(toolRegistery));

        for (const name of writingTools) expect(offered).not.toContain(name);
        expect(offered).toContain("read_file");
        // Kept deliberately: inspection is most of planning, and the
        // command-level gate in the loop is what makes it safe to offer.
        expect(offered).toContain("run_terminal");
      });
    });
  }
});

describe("structured parameters reach the provider", () => {
  test("Gemini renders an object array as an object array", async () => {
    // todo_write is why config/toolSchema.ts exists; all three clients used to
    // hardcode string items, which cannot express a status.
    const requests: any[] = [];
    const ai = {
      models: {
        async generateContentStream(request: unknown) {
          requests.push(request);
          return (async function* () {
            yield { candidates: [{ content: { parts: [{ text: "ok" }] } }] };
          })();
        },
      },
    };

    await drain(geminiClient("k", "m", ai as any));

    const todo = requests[0].config.tools[0].functionDeclarations.find(
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

  test("OpenAI and Anthropic carry the same enum", async () => {
    const fromOpenAI = fakeOpenAI(() => ({ events: [...textItem(0, "ok")] }));
    await drain(openaiClient("k", "m", fromOpenAI.api as never));

    const fromAnthropic = fakeAnthropic(() => ({
      events: [...textBlock(0, "ok"), ...messageStop()],
    }));
    await drain(anthropicClient("k", "m", fromAnthropic.api as never));

    for (const request of [fromOpenAI.requests[0], fromAnthropic.requests[0]]) {
      const todo = request.tools.find((tool: { name: string }) => tool.name === "todo_write");
      const schema = todo.parameters ?? todo.input_schema;

      expect(schema.properties.todos.items.type).toBe("object");
      expect(schema.properties.todos.items.properties.status.enum).toEqual([
        "pending",
        "in_progress",
        "completed",
      ]);
    }
  });
});
