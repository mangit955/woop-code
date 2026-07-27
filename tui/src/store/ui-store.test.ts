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
