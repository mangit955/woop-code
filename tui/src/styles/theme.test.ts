import { describe, expect, test } from "bun:test";
import {
  colors,
  dimHex,
  dimmedColors,
  dimmedMarkdownColors,
  markdownColors,
  DIM_AMOUNT,
} from "./theme";

describe("colour dimming", () => {
  test("moves a colour toward the terminal background", () => {
    // #e5e5e5 at 0.6 toward #0a0a0a lands on #626262.
    expect(dimHex("#e5e5e5")).toBe("#626262");
    expect(dimHex("#a3a3a3")).toBe("#474747");
  });

  test("respects the endpoints", () => {
    expect(dimHex("#3b82f6", 0)).toBe("#3b82f6");
    expect(dimHex("#3b82f6", 1)).toBe(colors.bgBase);
  });

  test("clamps an out-of-range amount instead of overshooting", () => {
    expect(dimHex("#3b82f6", -1)).toBe("#3b82f6");
    expect(dimHex("#3b82f6", 5)).toBe(colors.bgBase);
  });

  test("expands shorthand hex", () => {
    expect(dimHex("#fff")).toBe(dimHex("#ffffff"));
  });

  test("returns anything that is not hex untouched", () => {
    // A named colour must degrade to "not dimmed", never to a broken value.
    expect(dimHex("green")).toBe("green");
    expect(dimHex("")).toBe("");
    expect(dimHex("#12345")).toBe("#12345");
  });

  test("always produces a valid hex colour for a hex input", () => {
    for (const value of Object.values(colors)) {
      expect(dimHex(value)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("dimmed palettes", () => {
  test("cover every token of the palette they mirror", () => {
    expect(Object.keys(dimmedColors).sort()).toEqual(Object.keys(colors).sort());
    expect(Object.keys(dimmedMarkdownColors).sort()).toEqual(
      Object.keys(markdownColors).sort(),
    );
  });

  test("actually fade the readable tokens", () => {
    // If a token came back unchanged the background would not look dimmed.
    for (const token of ["textBase", "textMuted", "primary", "secondary"] as const) {
      expect(dimmedColors[token]).not.toBe(colors[token]);
    }
    for (const token of ["text", "heading", "strong"] as const) {
      expect(dimmedMarkdownColors[token]).not.toBe(markdownColors[token]);
    }
  });

  test("stay dimmer than their lit counterparts", () => {
    const luminance = (hex: string) =>
      (hex.match(/[0-9a-f]{2}/g) ?? []).reduce(
        (total, channel) => total + Number.parseInt(channel, 16),
        0,
      );

    for (const [token, value] of Object.entries(markdownColors)) {
      const dimmed = dimmedMarkdownColors[token as keyof typeof markdownColors];
      expect(luminance(dimmed)).toBeLessThanOrEqual(luminance(value));
    }
  });

  test("dims by the documented amount", () => {
    expect(DIM_AMOUNT).toBeGreaterThan(0);
    expect(DIM_AMOUNT).toBeLessThan(1);
    expect(dimmedColors.textBase).toBe(dimHex(colors.textBase, DIM_AMOUNT));
  });
});
