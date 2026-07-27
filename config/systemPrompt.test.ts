import { describe, expect, test } from "bun:test";
import { SYSTEM_PROMPT } from "./systemPrompt";

describe("SYSTEM_PROMPT", () => {
  test("keeps the edit approval workflow explicit", () => {
    expect(SYSTEM_PROMPT).toContain("read_file");
    expect(SYSTEM_PROMPT).toContain("edit_file");
    expect(SYSTEM_PROMPT).toContain("oldText must be copied exactly");
  });

  test("guides recovery without repeating duplicate tool calls", () => {
    expect(SYSTEM_PROMPT).toContain("tool fails or a duplicate call is skipped");
    expect(SYSTEM_PROMPT).toContain("identical arguments");
  });
});
