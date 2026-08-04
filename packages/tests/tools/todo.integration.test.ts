import { describe, expect, test, beforeEach } from "bun:test";
import { todoWriteTool } from "../../../tools/todo";
import { store } from "../../../tui/src/store/ui-store";
import type { TodoItem } from "../../../config/types";

/**
 * The tool against the real store, which is the only thing it touches.
 *
 * Every error message here is read by the model and is what it corrects itself
 * from, so each case asserts on the message and not merely that it threw.
 */

/** The list as the store currently holds it. */
function stored(): TodoItem[] | undefined {
  const item = store
    .getState()
    .timeline.filter((entry) => entry.type === "todo")
    .at(-1);

  return item?.type === "todo" ? item.items : undefined;
}

function todoItems(): Array<{ type: string }> {
  return store.getState().timeline.filter((entry) => entry.type === "todo");
}

describe("todo_write", () => {
  beforeEach(() => {
    store.clearTimeline();
  });

  test("records the list and echoes it back with a count", async () => {
    const result = await todoWriteTool.execute({
      todos: [
        { content: "Add runtime/planMode.ts", status: "completed" },
        { content: "Gate writes in the loop", status: "in_progress" },
        { content: "Register todo_write", status: "pending" },
      ],
    });

    expect(stored()).toEqual([
      { content: "Add runtime/planMode.ts", status: "completed" },
      { content: "Gate writes in the loop", status: "in_progress" },
      { content: "Register todo_write", status: "pending" },
    ]);

    expect(result).toContain("1/3 complete");
    expect(result).toContain("[x] Add runtime/planMode.ts");
    expect(result).toContain("[~] Gate writes in the loop");
    expect(result).toContain("[ ] Register todo_write");
  });

  test("replaces the previous list rather than stacking a second one", async () => {
    await todoWriteTool.execute({
      todos: [{ content: "First pass", status: "in_progress" }],
    });
    await todoWriteTool.execute({
      todos: [
        { content: "First pass", status: "completed" },
        { content: "Second pass", status: "in_progress" },
      ],
    });

    expect(todoItems()).toHaveLength(1);
    expect(stored()).toHaveLength(2);
    expect(stored()?.[0]?.status).toBe("completed");
  });

  test("keeps the list beside the latest work, not where it was first written", async () => {
    await todoWriteTool.execute({ todos: [{ content: "Step", status: "pending" }] });
    store.addUserMessage("and now this");
    await todoWriteTool.execute({ todos: [{ content: "Step", status: "completed" }] });

    // Last in the timeline: a checklist stranded above everything that has
    // happened since is worse than no checklist.
    expect(store.getState().timeline.at(-1)?.type).toBe("todo");
  });

  test("trims whitespace and caps a long step", async () => {
    await todoWriteTool.execute({
      todos: [{ content: `  ${"x".repeat(200)}  `, status: "pending" }],
    });

    expect(stored()?.[0]?.content).toHaveLength(120);
  });

  test("handles unicode and emoji", async () => {
    await todoWriteTool.execute({
      todos: [{ content: "café ☕ — 日本語 🚀", status: "pending" }],
    });

    expect(stored()?.[0]?.content).toBe("café ☕ — 日本語 🚀");
  });

  describe("refuses bad input, and changes nothing when it does", () => {
    test("a missing list", async () => {
      await expect(todoWriteTool.execute({})).rejects.toThrow(/todos must be an array/);
      expect(todoItems()).toHaveLength(0);
    });

    test("something that is not an array", async () => {
      await expect(todoWriteTool.execute({ todos: "one, two" })).rejects.toThrow(
        /todos must be an array/,
      );
    });

    test("an empty list", async () => {
      await expect(todoWriteTool.execute({ todos: [] })).rejects.toThrow(/todos is empty/);
      expect(todoItems()).toHaveLength(0);
    });

    test("an unknown status, naming what is accepted", async () => {
      const failure = todoWriteTool.execute({
        todos: [{ content: "Step", status: "doing" }],
      });

      await expect(failure).rejects.toThrow(/pending, in_progress, completed/);
      await expect(failure).rejects.toThrow(/"doing"/);
    });

    test("a missing status", async () => {
      await expect(
        todoWriteTool.execute({ todos: [{ content: "Step" }] }),
      ).rejects.toThrow(/not one of/);
    });

    test("empty content, naming which item", async () => {
      await expect(
        todoWriteTool.execute({
          todos: [
            { content: "Fine", status: "pending" },
            { content: "   ", status: "pending" },
          ],
        }),
      ).rejects.toThrow(/todos\[1\]/);
    });

    test("a string where an object belongs", async () => {
      await expect(todoWriteTool.execute({ todos: ["Step"] })).rejects.toThrow(
        /must be an object with content and status/,
      );
    });

    test("more items than are useful", async () => {
      const todos = Array.from({ length: 21 }, (_, index) => ({
        content: `Step ${index}`,
        status: "pending",
      }));

      await expect(todoWriteTool.execute({ todos })).rejects.toThrow(/more than the 20/);
    });

    test("a rejected call leaves an earlier list untouched", async () => {
      await todoWriteTool.execute({ todos: [{ content: "Good", status: "pending" }] });
      await expect(todoWriteTool.execute({ todos: [] })).rejects.toThrow();

      expect(stored()).toEqual([{ content: "Good", status: "pending" }]);
    });
  });
});
