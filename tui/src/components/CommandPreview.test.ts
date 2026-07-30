import { describe, expect, test } from "bun:test";
import { planCommandList } from "./CommandPreview";

describe("command popup row budget", () => {
  test("never occupies more rows than it was given", () => {
    // The bug: the list rendered every match regardless of the space available,
    // out of flow, so it painted over the header and the wordmark.
    for (let maxRows = 1; maxRows <= 20; maxRows++) {
      for (const showHeader of [true, false]) {
        for (let total = 1; total <= 14; total++) {
          for (let selectedIndex = 0; selectedIndex < total; selectedIndex++) {
            const plan = planCommandList({ maxRows, showHeader, total, selectedIndex });

            expect(plan.rows).toBeLessThanOrEqual(Math.max(maxRows, 1));
            expect(plan.end - plan.start).toBeGreaterThanOrEqual(1);
          }
        }
      }
    }
  });

  test("always keeps the selected command in view", () => {
    // Selection used to be able to sit above the clipped top of the popup, so
    // the arrows moved through commands the user could not see.
    for (let maxRows = 1; maxRows <= 12; maxRows++) {
      for (let selectedIndex = 0; selectedIndex < 10; selectedIndex++) {
        const plan = planCommandList({ maxRows, showHeader: true, total: 10, selectedIndex });

        expect(selectedIndex).toBeGreaterThanOrEqual(plan.start);
        expect(selectedIndex).toBeLessThan(plan.end);
      }
    }
  });

  test("shows the whole list when it fits", () => {
    const plan = planCommandList({ maxRows: 14, showHeader: true, total: 10, selectedIndex: 0 });

    expect(plan).toMatchObject({ start: 0, end: 10, showIndicators: false, showHeader: true });
    expect(plan.rows).toBe(12);
  });

  test("reports what is hidden in each direction", () => {
    const top = planCommandList({ maxRows: 8, showHeader: true, total: 10, selectedIndex: 0 });
    expect(top.hiddenAbove).toBe(0);
    expect(top.hiddenBelow).toBeGreaterThan(0);
    expect(top.showIndicators).toBe(true);

    const bottom = planCommandList({ maxRows: 8, showHeader: true, total: 10, selectedIndex: 9 });
    expect(bottom.hiddenAbove).toBeGreaterThan(0);
    expect(bottom.hiddenBelow).toBe(0);
  });

  test("spends the spare indicator row on a command at the list ends", () => {
    // Only one indicator is needed at the top, so the row the other would have
    // taken goes to the list instead of sitting blank.
    const atTop = planCommandList({ maxRows: 5, showHeader: true, total: 10, selectedIndex: 0 });
    const inMiddle = planCommandList({ maxRows: 5, showHeader: true, total: 10, selectedIndex: 5 });

    expect(atTop.end - atTop.start).toBe(2);
    expect(inMiddle.end - inMiddle.start).toBe(1);
    expect(atTop.rows).toBeLessThanOrEqual(5);
    expect(inMiddle.rows).toBeLessThanOrEqual(5);
  });

  test("drops the header when its rows are worth more as commands", () => {
    expect(planCommandList({ maxRows: 2, showHeader: true, total: 10, selectedIndex: 0 }).showHeader).toBe(false);
    expect(planCommandList({ maxRows: 3, showHeader: true, total: 10, selectedIndex: 0 }).showHeader).toBe(true);
  });

  test("gives at least one command even with a single row", () => {
    const plan = planCommandList({ maxRows: 1, showHeader: true, total: 10, selectedIndex: 4 });

    expect(plan.showHeader).toBe(false);
    expect(plan.rows).toBe(1);
    expect(plan.start).toBe(4);
    expect(plan.end).toBe(5);
  });
});
