import { describe, expect, test } from "bun:test";
import { UIStore } from "./ui-store";

describe("UIStore conversation scrolling", () => {
  test("scrolls only within the measured transcript bounds", () => {
    const store = new UIStore();
    store.setScrollLimit(10);

    store.scrollUp();
    expect(store.getState().scrollOffset).toBe(1);

    store.pageUp();
    expect(store.getState().scrollOffset).toBe(9);

    store.pageUp();
    expect(store.getState().scrollOffset).toBe(10);

    store.scrollDown();
    expect(store.getState().scrollOffset).toBe(9);

    store.pageDown();
    expect(store.getState().scrollOffset).toBe(1);

    store.pageDown();
    expect(store.getState().scrollOffset).toBe(0);
  });

  test("clamps the position when the conversation or viewport shrinks", () => {
    const store = new UIStore();
    store.setScrollLimit(12);
    store.scrollToTop();
    expect(store.getState().scrollOffset).toBe(12);

    store.setScrollLimit(4);
    expect(store.getState().scrollOffset).toBe(4);
  });
});

describe("UIStore edit approvals", () => {
  test("scrolls a diff from its first line toward its last line", () => {
    const store = new UIStore();
    store.setPendingEditScrollLimit(12);

    store.scrollPendingEditBy(3);
    expect(store.getState().pendingEditScrollOffset).toBe(3);

    store.scrollPendingEditBy(20);
    expect(store.getState().pendingEditScrollOffset).toBe(12);

    store.scrollPendingEditBy(-5);
    expect(store.getState().pendingEditScrollOffset).toBe(7);

    store.scrollPendingEditToStart();
    expect(store.getState().pendingEditScrollOffset).toBe(0);
  });

  test("exposes a pending edit until it is approved", async () => {
    const store = new UIStore();
    const pending = store.setPendingEdit({
      id: "edit-1",
      filePath: "src/example.ts",
      oldContent: "old",
      newContent: "new",
      diff: "@@ -1 +1 @@\n-old\n+new",
      toolCallId: "tool-1",
    });

    expect(store.getState().pendingEdit?.id).toBe("edit-1");
    store.approvePendingEdit();
    await expect(pending).resolves.toBe(true);
    expect(store.getState().pendingEdit).toBeNull();
  });

  test("marks a failed tool instead of leaving a spinner running", () => {
    const store = new UIStore();
    store.startTool({ id: "tool-1", name: "edit_file", arguments: {} });
    store.failTool("tool-1");

    expect(store.getState().timeline.at(-1)).toMatchObject({
      type: "tool",
      status: "failed",
    });
  });
});
