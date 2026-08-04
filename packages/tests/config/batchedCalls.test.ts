import { describe, test, expect } from "bun:test";
import { buildContents } from "../../../providers/client";
import type { Message } from "../../../config/types";

/**
 * A response that requested two tools at once, as the loop records it: one
 * message per call, results interleaved, and a signature only on the first —
 * which is all Gemini provides.
 */
function batchedTurn(): Message[] {
  return [
    { role: "user", content: "read both files" },
    {
      role: "assistant_tool_call",
      toolName: "read_file",
      toolCallId: "c1",
      arguments: { path: "a.ts" },
      thoughtSignature: "sig-1",
      batchId: "batch-1",
    },
    { role: "tool", toolName: "read_file", toolCallId: "c1", content: "aaa" },
    {
      role: "assistant_tool_call",
      toolName: "read_file",
      toolCallId: "c2",
      arguments: { path: "b.ts" },
      batchId: "batch-1",
    },
    { role: "tool", toolName: "read_file", toolCallId: "c2", content: "bbb" },
  ];
}

const modelTurns = (contents: any[]) =>
  contents.filter((c) => c.role === "model");

describe("a response that requested several tools at once", () => {
  /**
   * Probed directly against the API before this was written: separate model
   * turns are rejected with "Function call is missing a thought_signature in
   * functionCall parts", while one turn carrying every call is accepted.
   */
  test("becomes a single model turn carrying every call", () => {
    const contents = buildContents(batchedTurn()) as any[];
    const turns = modelTurns(contents);

    expect(turns).toHaveLength(1);
    expect(turns[0].parts).toHaveLength(2);
    expect(turns[0].parts.map((p: any) => p.functionCall.name)).toEqual([
      "read_file",
      "read_file",
    ]);
  });

  test("keeps the signature on the part that carries it", () => {
    const parts = (modelTurns(buildContents(batchedTurn()) as any[])[0] as any).parts;

    expect(parts[0].thoughtSignature).toBe("sig-1");
    // The provider signs only the first part of a batch; inventing one for the
    // rest would be worse than sending none.
    expect(parts[1].thoughtSignature).toBeUndefined();
  });

  test("every result still follows, in call order", () => {
    const contents = buildContents(batchedTurn()) as any[];
    const responses = contents
      .flatMap((c: any) => c.parts)
      .filter((p: any) => p.functionResponse);

    expect(responses).toHaveLength(2);
    expect(responses.map((r: any) => r.functionResponse.response.result)).toEqual([
      "aaa",
      "bbb",
    ]);
  });

  test("no call or result is lost", () => {
    const contents = buildContents(batchedTurn()) as any[];
    const parts = contents.flatMap((c: any) => c.parts);

    expect(parts.filter((p: any) => p.functionCall)).toHaveLength(2);
    expect(parts.filter((p: any) => p.functionResponse)).toHaveLength(2);
    expect(parts.filter((p: any) => p.text)).toHaveLength(1);
  });
});

describe("a response that requested one tool", () => {
  const single: Message[] = [
    { role: "user", content: "read it" },
    {
      role: "assistant_tool_call",
      toolName: "read_file",
      toolCallId: "c1",
      arguments: { path: "a.ts" },
      thoughtSignature: "sig-1",
      batchId: "batch-1",
    },
    { role: "tool", toolName: "read_file", toolCallId: "c1", content: "aaa" },
  ];

  test("is unchanged: one turn, one call", () => {
    const turns = modelTurns(buildContents(single) as any[]);
    expect(turns).toHaveLength(1);
    expect((turns[0] as any).parts).toHaveLength(1);
  });
});

describe("history recorded before batching was tracked", () => {
  test("calls without a batchId keep the previous shape", () => {
    // Persisted conversations and older recordings have no batchId. They came
    // from single-call responses, where the question does not arise.
    const legacy: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant_tool_call",
        toolName: "read_file",
        toolCallId: "c1",
        arguments: { path: "a.ts" },
        thoughtSignature: "sig-1",
      },
      { role: "tool", toolName: "read_file", toolCallId: "c1", content: "aaa" },
      {
        role: "assistant_tool_call",
        toolName: "read_file",
        toolCallId: "c2",
        arguments: { path: "b.ts" },
        thoughtSignature: "sig-2",
      },
      { role: "tool", toolName: "read_file", toolCallId: "c2", content: "bbb" },
    ];

    expect(modelTurns(buildContents(legacy) as any[])).toHaveLength(2);
  });
});

describe("separate batches", () => {
  test("are not merged with each other", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant_tool_call",
        toolName: "read_file",
        toolCallId: "c1",
        arguments: { path: "a.ts" },
        thoughtSignature: "sig-1",
        batchId: "batch-1",
      },
      { role: "tool", toolName: "read_file", toolCallId: "c1", content: "aaa" },
      {
        role: "assistant_tool_call",
        toolName: "read_file",
        toolCallId: "c2",
        arguments: { path: "b.ts" },
        thoughtSignature: "sig-2",
        batchId: "batch-2",
      },
      { role: "tool", toolName: "read_file", toolCallId: "c2", content: "bbb" },
    ];

    const turns = modelTurns(buildContents(messages) as any[]);
    expect(turns).toHaveLength(2);
    expect((turns[0] as any).parts).toHaveLength(1);
    expect((turns[1] as any).parts).toHaveLength(1);
  });
});

describe("a batch cut short", () => {
  test("emits the calls it has, without inventing results", () => {
    // A turn cancelled or failed part-way leaves a call with no result.
    const partial: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant_tool_call",
        toolName: "read_file",
        toolCallId: "c1",
        arguments: { path: "a.ts" },
        thoughtSignature: "sig-1",
        batchId: "batch-1",
      },
      {
        role: "assistant_tool_call",
        toolName: "read_file",
        toolCallId: "c2",
        arguments: { path: "b.ts" },
        batchId: "batch-1",
      },
      { role: "tool", toolName: "read_file", toolCallId: "c1", content: "aaa" },
    ];

    const contents = buildContents(partial) as any[];
    const parts = contents.flatMap((c: any) => c.parts);

    expect(modelTurns(contents)).toHaveLength(1);
    expect(parts.filter((p: any) => p.functionCall)).toHaveLength(2);
    expect(parts.filter((p: any) => p.functionResponse)).toHaveLength(1);
  });
});
