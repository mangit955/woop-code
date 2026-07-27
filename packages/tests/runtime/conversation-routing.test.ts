import { describe, expect, test } from "bun:test";
import { isConversationalPrompt } from "../../../commands/agentController";

describe("conversation routing", () => {
  test("keeps casual conversation out of the tool-enabled agent path", () => {
    expect(isConversationalPrompt("hey")).toBe(true);
    expect(isConversationalPrompt("What can you do?")).toBe(true);
    expect(isConversationalPrompt("thanks!")).toBe(true);
  });

  test("keeps repository tasks in the tool-enabled agent path", () => {
    expect(isConversationalPrompt("fix the failing test")).toBe(false);
    expect(isConversationalPrompt("explain this project")).toBe(false);
    expect(isConversationalPrompt("hey, update the README")).toBe(false);
  });
});
