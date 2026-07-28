import { describe, expect, test } from "bun:test";
import { questionTool } from "../../../tools/question";
import { store } from "../../../tui/src/store/ui-store";

describe("ask_user tool", () => {
  test("returns only answers supplied by the user", async () => {
    let pendingQuestion: unknown;
    store.setPendingQuestion = async (question: unknown) => {
      pendingQuestion = question;
      return ["SQLite", "Yes"];
    };

    const result = await questionTool.execute({
      questions: ["Which database?", "Add tests?"],
    });

    expect(pendingQuestion).toMatchObject({ questions: ["Which database?", "Add tests?"] });
    expect(result).toContain("A: SQLite");
    expect(result).toContain("A: Yes");
    expect(result).not.toContain("[User input required");
  });

  test("does not invent an answer when the user cancels", async () => {
    store.setPendingQuestion = async () => null;

    await expect(questionTool.execute({ questions: ["Which database?"] })).resolves.toBe(
      "The user declined to answer these questions. Do not assume an answer; explain the blocker or ask a narrower question.",
    );
  });
});
