import { describe, test, expect, beforeEach, mock } from "bun:test";
import { agentLoop } from "../../../config/runtime";
import { MockTool, MockToolRegistry } from "../shared/mocks";
import { createRuntimeTest } from "../shared/testHelpers";
import { createUserMessage } from "../shared/factories";
import path from "path";

const mockToolRegistry = new MockToolRegistry();
const getTool = mock((name: string) => mockToolRegistry.get(name));
mock.module("../../../tools", () => ({ getTool }));

interface GoldenTest {
  description: string;
  input: {
    userPrompt: string;
    repoContext: string;
    cancelAfterMs?: number;
  };
  providerResponse: {
    events?: any[];
    iterations?: Array<{ events: any[] }>;
    error?: string;
  };
  toolResponse?: Record<string, string>;
  expectedConversation?: any[];
  expectedResult?: string;
  expectedError?: string;
  expectedCallbacks: {
    onText?: number | string;
    onDone?: number;
    onToolStart?: number;
    onToolFinish?: number;
    onError?: number;
    onCancel?: number;
  };
  note?: string;
}

async function loadGoldenTest(filename: string): Promise<GoldenTest> {
  const filePath = path.join(__dirname, "../goldens", filename);
  const file = Bun.file(filePath);
  return JSON.parse(await file.text());
}

async function runGoldenTest(golden: GoldenTest) {
  const { callbacks, messages } = createRuntimeTest();
  messages[0] = createUserMessage(golden.input.userPrompt);

  // Setup tools if needed
  if (golden.toolResponse) {
    for (const [toolName, toolResult] of Object.entries(golden.toolResponse)) {
      const tool = new MockTool(toolName, toolResult);
      mockToolRegistry.register(tool);
    }
  }

  // Create provider based on golden
  let provider: any;

  if (golden.providerResponse.error) {
    provider = {
      async *stream() {
        throw new Error(golden.providerResponse.error);
      },
    };
  } else if (golden.providerResponse.iterations) {
    let iterationCount = 0;
    provider = {
      async *stream(_msgs: any, _ctx: any, signal?: AbortSignal) {
        if (iterationCount < golden.providerResponse.iterations!.length) {
          const iteration = golden.providerResponse.iterations![iterationCount++];
          for (const event of iteration!.events) {
            if (signal?.aborted) return;
            yield event;
          }
        }
      },
    };
  } else {
    provider = {
      async *stream(_msgs: any, _ctx: any, signal?: AbortSignal) {
        for (const event of golden.providerResponse.events!) {
          if (signal?.aborted) return;
          // Add small delay if cancellation is expected
          if (golden.input.cancelAfterMs) {
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          yield event;
        }
      },
    };
  }

  // Handle cancellation
  let abortController: AbortController | undefined;
  if (golden.input.cancelAfterMs) {
    abortController = new AbortController();
    setTimeout(() => abortController!.abort(), golden.input.cancelAfterMs);
  }

  // Run the test
  if (golden.expectedError) {
    await expect(
      agentLoop(
        provider,
        messages,
        golden.input.repoContext,
        callbacks,
        abortController?.signal,
      ),
    ).rejects.toThrow();
  } else {
    const result = await agentLoop(
      provider,
      messages,
      golden.input.repoContext,
      callbacks,
      abortController?.signal,
    );

    if (golden.expectedResult !== undefined) {
      expect(result).toBe(golden.expectedResult);
    }

    if (golden.expectedConversation) {
      // Compare conversation structure (ignoring exact IDs)
      const actualRoles = messages.map((m) => m.role);
      const expectedRoles = golden.expectedConversation.map((m: any) => m.role);
      expect(actualRoles).toEqual(expectedRoles);
    }
  }

  // Verify callbacks
  for (const [callbackName, expectedCount] of Object.entries(
    golden.expectedCallbacks,
  )) {
    const actualCount = callbacks.getCallsByName(callbackName).length;

    if (typeof expectedCount === "number") {
      expect(actualCount).toBe(expectedCount);
    } else if (typeof expectedCount === "string" && expectedCount.startsWith(">=")) {
      const minCount = parseInt(expectedCount.split(" ")[1]!);
      expect(actualCount).toBeGreaterThanOrEqual(minCount);
    }
  }
}

describe("agentLoop - Golden Tests", () => {
  beforeEach(() => {
    mockToolRegistry.clear();
  });

  test("basic_chat.json", async () => {
    const golden = await loadGoldenTest("basic_chat.json");
    await runGoldenTest(golden);
  });

  test("tool_call.json", async () => {
    const golden = await loadGoldenTest("tool_call.json");
    await runGoldenTest(golden);
  });

  test("cancellation.json", async () => {
    const golden = await loadGoldenTest("cancellation.json");
    await runGoldenTest(golden);
  });

  test("provider_error.json", async () => {
    const golden = await loadGoldenTest("provider_error.json");
    await runGoldenTest(golden);
  });
});
