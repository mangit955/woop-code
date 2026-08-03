import { describe, expect, test } from "bun:test";
import { SYSTEM_PROMPT } from "./systemPrompt";

describe("SYSTEM_PROMPT", () => {
  test("keeps the edit approval workflow explicit", () => {
    expect(SYSTEM_PROMPT).toContain("read_file");
    expect(SYSTEM_PROMPT).toContain("edit_file");
    expect(SYSTEM_PROMPT).toContain("oldText must be copied exactly");
  });

  // Across a five-task benchmark run the model batched nothing: every one of
  // 586 iterations carried exactly one tool call, while the loop and the
  // provider client have handled batches all along. The only nudge was a
  // half-sentence inside a numbered workflow.
  test("asks for independent tool calls to be batched", () => {
    expect(SYSTEM_PROMPT).toContain(
      "Call independent tools together in a single response",
    );
    // Paired with a worked example: the instruction alone reads as a
    // preference, and this is the pattern the model actually repeats.
    expect(SYSTEM_PROMPT).toContain("git status");
  });

  test("guides recovery without repeating duplicate tool calls", () => {
    expect(SYSTEM_PROMPT).toContain("tool fails or a duplicate call is skipped");
    expect(SYSTEM_PROMPT).toContain("identical arguments");
  });

  test("requires rejected edits to be reported as unapplied", () => {
    expect(SYSTEM_PROMPT).toContain("rejected or cancelled edit means the file is unchanged");
    expect(SYSTEM_PROMPT).toContain("never report the proposed change as completed");
  });
});
