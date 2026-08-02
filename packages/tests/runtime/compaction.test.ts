import { describe, test, expect } from "bun:test";
import {
  DEFAULT_TOOL_HISTORY_BUDGET,
  compactToolHistory,
  toolHistoryBudget,
} from "../../../runtime/compaction";
import { measureSegments } from "../../../config/runtime";
import {
  createAssistantToolCallMessage,
  createToolMessage,
  createUserMessage,
} from "../shared/factories";
import type { Message } from "../../../config/types";

/** A turn: one task instruction followed by `n` read/result pairs. */
function history(n: number, resultChars = 4_000): Message[] {
  const messages: Message[] = [createUserMessage("fix the parser")];
  for (let i = 0; i < n; i++) {
    messages.push(
      createAssistantToolCallMessage("read_file", `c${i}`, { path: `file-${i}.ts` }),
      createToolMessage("read_file", `c${i}`, "x\n".repeat(resultChars / 2)),
    );
  }
  return messages;
}

describe("what compaction must never do", () => {
  /**
   * Both properties were measured against the recorded benchmark corpus before
   * this strategy was chosen. Dropping oldest-first would have removed the task
   * instruction in 568 iterations and orphaned 217 tool results.
   */
  test("the task instruction always survives", () => {
    const compacted = compactToolHistory(history(50), 1_000);

    expect(compacted.filter((m) => m.role === "user")).toHaveLength(1);
    expect((compacted[0] as { content: string }).content).toBe("fix the parser");
  });

  test("no tool result is orphaned from its call", () => {
    const compacted = compactToolHistory(history(50), 1_000);

    const callIds = new Set(
      compacted
        .filter((m) => m.role === "assistant_tool_call")
        .map((m) => (m as { toolCallId: string }).toolCallId),
    );
    for (const message of compacted) {
      if (message.role === "tool") expect(callIds.has(message.toolCallId)).toBe(true);
    }
  });

  test("the message count and order are unchanged", () => {
    const original = history(20);
    const compacted = compactToolHistory(original, 1_000);

    expect(compacted).toHaveLength(original.length);
    expect(compacted.map((m) => m.role)).toEqual(original.map((m) => m.role));
  });

  test("the input is not mutated", () => {
    // The loop keeps the full results: the execution log is built from them
    // after the turn, and compacting what is sent must not compact what
    // happened.
    const original = history(20);
    const before = JSON.stringify(original);
    compactToolHistory(original, 1_000);

    expect(JSON.stringify(original)).toBe(before);
  });

  test("the newest result is kept whole even under a zero budget", () => {
    // A turn that cannot see the result it just received cannot act on it.
    const compacted = compactToolHistory(history(5), 0);
    const last = compacted.at(-1) as { content: string };

    expect(last.content.length).toBeGreaterThan(1_000);
  });
});

describe("what compaction does", () => {
  test("old results become their outcome", () => {
    const compacted = compactToolHistory(history(30), 8_000);
    const oldest = compacted.find((m) => m.role === "tool") as { content: string };

    expect(oldest.content).toBe("2000 lines");
  });

  test("old call arguments keep their head", () => {
    const messages: Message[] = [
      createUserMessage("write it"),
      createAssistantToolCallMessage("create_file", "c1", {
        path: "big.ts",
        content: "z".repeat(9_000),
      }),
      createToolMessage("create_file", "c1", "Created"),
      createAssistantToolCallMessage("read_file", "c2", { path: "other.ts" }),
      createToolMessage("read_file", "c2", "x".repeat(5_000)),
    ];

    const compacted = compactToolHistory(messages, 5_100);
    const call = compacted[1] as { arguments: Record<string, unknown> };

    // Arguments were 86% of the tool history on one recorded trajectory, so
    // compacting results alone would have missed most of the growth there.
    expect(call.arguments.path).toBe("big.ts");
    expect(String(call.arguments.content)).toStartWith("zzz");
    expect(String(call.arguments.content)).toContain("more characters omitted");
    expect(String(call.arguments.content).length).toBeLessThan(300);
  });

  test("short arguments are left alone, because they are the identity", () => {
    const compacted = compactToolHistory(history(30), 0);
    const call = compacted[1] as { arguments: Record<string, unknown> };

    expect(call.arguments.path).toBe("file-0.ts");
  });

  test("recent history stays verbatim", () => {
    const compacted = compactToolHistory(history(30), 12_000);
    const results = compacted.filter((m) => m.role === "tool") as Array<{
      content: string;
    }>;

    // Roughly three 4k results fit the budget; the exact count is not the
    // contract, but the newest surviving whole is.
    expect(results.at(-1)!.content.length).toBe(4_000);
    expect(results[0]!.content).toBe("2000 lines");
  });

  test("a history already inside the budget is untouched", () => {
    const original = history(2);
    expect(compactToolHistory(original, 100_000)).toEqual(original);
  });

  test("it bounds what the request carries", () => {
    const before = measureSegments(history(60), "");
    const after = measureSegments(compactToolHistory(history(60), 20_000), "");

    expect(before.toolResults).toBeGreaterThan(200_000);
    expect(after.toolResults).toBeLessThan(40_000);
    expect(after.conversation).toBe(before.conversation);
  });

  test("compaction is deterministic", () => {
    // Same transcript, same context — nothing here consults a model.
    const first = compactToolHistory(history(30), 9_000);
    const second = compactToolHistory(history(30), 9_000);
    expect(first).toEqual(second);
  });
});

describe("budget configuration", () => {
  test("defaults when unset", () => {
    expect(toolHistoryBudget({})).toBe(DEFAULT_TOOL_HISTORY_BUDGET);
  });

  test("WOOPCODE_TOOL_HISTORY_BUDGET overrides it", () => {
    expect(toolHistoryBudget({ WOOPCODE_TOOL_HISTORY_BUDGET: "5000" })).toBe(5_000);
  });

  test("zero is honoured, since it is a meaningful setting", () => {
    expect(toolHistoryBudget({ WOOPCODE_TOOL_HISTORY_BUDGET: "0" })).toBe(0);
  });

  test("a nonsense value falls back rather than disabling the prompt", () => {
    expect(toolHistoryBudget({ WOOPCODE_TOOL_HISTORY_BUDGET: "soon" })).toBe(
      DEFAULT_TOOL_HISTORY_BUDGET,
    );
    expect(toolHistoryBudget({ WOOPCODE_TOOL_HISTORY_BUDGET: "-5" })).toBe(
      DEFAULT_TOOL_HISTORY_BUDGET,
    );
  });
});
