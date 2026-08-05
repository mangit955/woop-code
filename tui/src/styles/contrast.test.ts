import { describe, expect, test } from "bun:test";
import { colors } from "./theme";

/**
 * Contrast, as a number rather than an opinion.
 *
 * "Is this readable?" sounds like taste and mostly is not. The pairs below are
 * the ones a token change can quietly break — foreground on a selected row,
 * text on a floating panel, and the border that says where that panel stops —
 * and each has a threshold that can be checked without a terminal.
 *
 * The border is the reason this file exists. `bgElevated` sits 1.14:1 above
 * `bgCanvas`, which is nowhere near enough to show an edge, so the border
 * carries the whole separation. Drawn in `borderBase` it measured 1.78:1
 * against the panel — a boundary invisible on a dim display, which is exactly
 * the problem the border was added to fix. Nothing rendered would have caught
 * it: the frame is identical either way, and only the arithmetic disagrees.
 */

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => {
    const srgb = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** WCAG 1.4.3, small text. */
const AA_TEXT = 4.5;
/** WCAG 1.4.11, non-text: UI boundaries and state indicators. */
const AA_NON_TEXT = 3;

describe("contrast ratio", () => {
  test("agrees with known values", () => {
    // Anchors the maths itself, so a wrong formula cannot make the thresholds
    // below pass by being generous.
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#000000", "#000000")).toBeCloseTo(1, 5);
    // Order must not matter.
    expect(contrastRatio("#aca3ec", "#0a0a0a")).toBeCloseTo(
      contrastRatio("#0a0a0a", "#aca3ec"),
      5,
    );
  });
});

describe("selected rows stay readable", () => {
  test("primary and secondary text clear AA on the selection fill", () => {
    expect(contrastRatio(colors.selectionFg, colors.selectionBg)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(colors.selectionFgMuted, colors.selectionBg)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  test("the warning on a selected row clears the non-text bar", () => {
    // "unsafe" beside an approval mode. It is short, coloured, and paired with
    // a label that already carries the meaning, so it is held to 1.4.11 rather
    // than to body-text contrast.
    expect(contrastRatio(colors.selectionFgWarn, colors.selectionBg)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

describe("a floating panel is actually delimited", () => {
  test("the fill alone cannot do it, which is why the border exists", () => {
    // Not a requirement — a record of the fact the border is load-bearing. If
    // this ever clears 3:1 the border could become optional; until then it
    // cannot.
    expect(contrastRatio(colors.bgElevated, colors.bgCanvas)).toBeLessThan(AA_NON_TEXT);
  });

  test("the border clears 3:1 against both surfaces it separates", () => {
    // Both sides, not just one. A border only readable against the darker side
    // still leaves the panel edge ambiguous where it meets the panel.
    expect(contrastRatio(colors.borderElevated, colors.bgCanvas)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    expect(contrastRatio(colors.borderElevated, colors.bgElevated)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  test("panel text clears AA on the elevated surface", () => {
    expect(contrastRatio(colors.textBase, colors.bgElevated)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(colors.textMuted, colors.bgElevated)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe("the transcript stays readable on the canvas", () => {
  test("body and accent text clear AA", () => {
    for (const token of ["textBase", "textMuted", "primary", "accent", "successBase", "warningBase", "dangerBase"] as const) {
      expect(
        contrastRatio(colors[token], colors.bgCanvas),
        `${token} on bgCanvas`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  test("inline code clears AA on its own background", () => {
    expect(contrastRatio(colors.accent, colors.bgCode)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});
