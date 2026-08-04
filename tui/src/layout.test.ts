import { describe, expect, test } from "bun:test";
import { fitWidth, planLayout, truncateStart, windowAround } from "./layout";
import { FULL_WORDMARK_COLUMNS } from "./components/AsciiLogo";

describe("layout planning", () => {
  test("keeps the full experience in a roomy terminal", () => {
    const layout = planLayout(100, 30);

    expect(layout.wordmark).toBe("full");
    expect(layout.composer).toBe("block");
    expect(layout.showStatusBar).toBe(true);
    expect(layout.showCapabilities).toBe(true);
    expect(layout.showKeyHints).toBe(true);
    expect(layout.rhythm).toBe(3);
  });

  test("drops the context meter before the keys that say what a press does", () => {
    // The meter reports; the hints instruct. On a status bar too narrow for
    // both, the one that cannot change what happens next is the one to lose.
    expect(planLayout(72, 30).showContextMeter).toBe(true);
    expect(planLayout(71, 30).showContextMeter).toBe(false);
    expect(planLayout(71, 30).showKeyHints).toBe(true);

    for (let width = 20; width <= 120; width++) {
      const layout = planLayout(width, 30);
      if (layout.showContextMeter) expect(layout.showKeyHints).toBe(true);
    }
  });

  test("swaps the wordmark for the compact mark before it can clip", () => {
    // The figlet is 73 columns; anything narrower must not render it.
    expect(planLayout(FULL_WORDMARK_COLUMNS + 4, 30).wordmark).toBe("full");
    expect(planLayout(FULL_WORDMARK_COLUMNS, 30).wordmark).toBe("compact");
    expect(planLayout(40, 24).wordmark).toBe("compact");
    expect(planLayout(20, 8).wordmark).toBe("hidden");
  });

  test("drops the bordered composer rather than overlapping the transcript", () => {
    // 80x10 is the reported break: fixed chrome exceeded the window and the
    // footer landed on top of the input.
    const short = planLayout(80, 10);
    expect(short.showStatusBar).toBe(false);

    const chrome =
      1 + // header
      (short.composer === "block" ? 6 : 1) +
      (short.showStatusBar ? 1 : 0);
    expect(chrome).toBeLessThan(10);
  });

  test("never lets fixed chrome exceed the terminal height", () => {
    for (let height = 4; height <= 40; height++) {
      const layout = planLayout(80, height);
      const chrome =
        1 + // header
        (layout.composer === "block" ? 6 : 1) +
        (layout.showStatusBar ? 1 : 0);

      expect(chrome).toBeLessThanOrEqual(height);
    }
  });

  test("leaves the command popup room without displacing the chrome", () => {
    // The popup renders in flow above the composer, so its budget plus the
    // chrome it must not cover has to fit the window.
    for (let height = 6; height <= 40; height++) {
      const layout = planLayout(80, height);
      const chrome =
        1 + // header
        (layout.composer === "block" ? 6 : 1) +
        (layout.showStatusBar ? 1 : 0);

      expect(chrome + layout.commandPopupRows).toBeLessThanOrEqual(height);
      expect(layout.commandPopupRows).toBeGreaterThanOrEqual(1);
    }
  });

  test("sheds detail as columns run out, in priority order", () => {
    // The provider tag goes before the model name, the tagline before the branch.
    expect(planLayout(100, 24).showComposerProvider).toBe(true);
    expect(planLayout(40, 24).showComposerProvider).toBe(false);
    expect(planLayout(40, 24).showTurnModel).toBe(true);
    expect(planLayout(20, 24).showTurnModel).toBe(false);
    expect(planLayout(100, 24).showHeaderTagline).toBe(true);
    expect(planLayout(40, 24).showHeaderTagline).toBe(false);
    expect(planLayout(20, 24).showHeaderMeta).toBe(false);
  });
});

describe("width fitting", () => {
  test("prefers the design width when there is room for it", () => {
    expect(fitWidth(120)).toBe(68);
    expect(fitWidth(72)).toBe(68);
  });

  test("gives up the minimum before it overflows the terminal", () => {
    // The old dialog was pinned to 68 columns and simply overran narrow windows.
    expect(fitWidth(40)).toBe(36);
    expect(fitWidth(24)).toBe(20);
    expect(fitWidth(10)).toBe(10);
    expect(fitWidth(1)).toBe(1);
  });

  test("never returns a width wider than the terminal", () => {
    for (let width = 1; width <= 200; width++) {
      expect(fitWidth(width)).toBeLessThanOrEqual(width);
      expect(fitWidth(width)).toBeGreaterThan(0);
    }
  });

  test("dialogs fit their own chrome plus a scrollable list", () => {
    for (let height = 6; height <= 40; height++) {
      const layout = planLayout(80, height);
      const fixed =
        2 + // padding
        1 + layout.dialogRhythm + // title
        1 + layout.dialogRhythm + // search
        (layout.showDialogLabel ? 1 : 0) +
        layout.dialogRhythm + // list margin
        (layout.showDialogHints ? 3 : 0);

      const indicators = layout.showDialogScrollIndicators ? 2 : 0;
      expect(fixed + layout.dialogListRows + indicators).toBeLessThanOrEqual(height);
      expect(layout.dialogListRows).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("list windowing", () => {
  test("shows everything when the list already fits", () => {
    expect(windowAround(0, 5, 10)).toEqual({ start: 0, end: 5 });
  });

  test("keeps the selection inside the window", () => {
    for (let selected = 0; selected < 11; selected++) {
      const { start, end } = windowAround(selected, 11, 4);
      expect(selected).toBeGreaterThanOrEqual(start);
      expect(selected).toBeLessThan(end);
      expect(end - start).toBe(4);
    }
  });

  test("stops at the list bounds instead of scrolling past them", () => {
    expect(windowAround(0, 11, 4)).toEqual({ start: 0, end: 4 });
    expect(windowAround(10, 11, 4)).toEqual({ start: 7, end: 11 });
  });
});

describe("path truncation", () => {
  test("keeps the end of the path, which is the part that identifies it", () => {
    expect(truncateStart("~/Developer/s-30/woop-code", 12)).toBe("…0/woop-code");
    expect(truncateStart("~/Developer/s-30/woop-code", 11)).toBe("…/woop-code");
    expect(truncateStart("~/short", 12)).toBe("~/short");
  });

  test("degrades safely at tiny widths", () => {
    expect(truncateStart("~/Developer/woop", 1)).toBe("…");
    expect(truncateStart("~/Developer/woop", 0)).toBe("");
  });
});
