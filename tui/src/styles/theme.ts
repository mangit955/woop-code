/**
 * The one place a colour literal appears.
 *
 * The interface is a single periwinkle accent over neutrals, with amber, emerald
 * and red reserved for meaning — plan mode, success, failure — and teal for
 * code. Everything else in `tui/` reads a token from here, so a hue cannot enter
 * the interface without being named first. `styles/tokens.test.ts` enforces that:
 * it fails on a raw hex or a named ANSI colour anywhere outside this directory.
 *
 * The rule is worth the test. The palette had fractured into five sources — this
 * file, a separate markdown palette on One Dark hues, a syntax theme on a third
 * set, an orange selection row hardcoded into all four pickers, and bare
 * `color="green"` ANSI — so one screen could show ten hues from four systems.
 */

export const colors = {
  // Text colors
  textBase: "#e5e5e5", // Neutral 200
  textMuted: "#a3a3a3", // Neutral 400
  textFaint: "#737373", // Neutral 500
  textStrong: "#ffffff",
  textAccent: "#aca3ec",
  textCode: "#2dd4bf", // Teal 400

  // ─── Surfaces ──────────────────────────────────────────────────────────────
  //
  // Named for what they are in the stack rather than for a neutral step, and
  // these are the values actually painted. The app used to draw #000000,
  // #101010, #1a1a1a and #1e1e1e as literals while the tokens described a
  // different set entirely — which meant `dimHex` faded toward a colour nothing
  // ever drew.
  /** What the app paints edge to edge. Every layer below sits on this. */
  bgCanvas: "#000000",
  bgBase: "#0a0a0a", // Neutral 950
  bgLayer01: "#171717", // Neutral 900
  bgLayer02: "#262626", // Neutral 800
  /** A dialog floating over the app. Paired with a border — see bgElevated's use. */
  bgElevated: "#141414",
  /** Recessed strips: the composer card, the command popup, a quoted command. */
  bgInset: "#1a1a1a",
  /** Behind an inline code span. */
  bgCode: "#1e1e1e",

  // Border colors
  borderBase: "#404040", // Neutral 700
  borderMuted: "#262626", // Neutral 800
  borderStrong: "#525252", // Neutral 600
  borderActive: "#aca3ec", // Periwinkle
  /**
   * The edge of a floating panel, and the one border that carries real meaning.
   *
   * Brighter than `borderBase` on purpose. `bgElevated` sits only 1.14:1 above
   * `bgCanvas`, so the fill cannot say where the dialog stops — the border is
   * the separation, and a border below 3:1 against the surfaces on either side
   * of it is one nobody sees on a dim display. Measured, this is 3.11:1 against
   * the panel and 3.55:1 against the canvas, clearing WCAG 1.4.11 on both sides;
   * `borderBase` managed 1.78 and 2.03. `styles/contrast.test.ts` holds the bar.
   */
  borderElevated: "#646464",

  // ─── Selection ─────────────────────────────────────────────────────────────
  //
  // The highlighted row in every picker. It is the accent, not a hue of its own:
  // this was #fb923c orange in four separate components, a colour that appeared
  // in no token and belonged to no part of the identity.
  selectionBg: "#aca3ec",
  selectionFg: "#0a0a0a",
  /** Secondary text on a selected row — a description, a timestamp. */
  selectionFgMuted: "#3d3866",
  /** A warning on a selected row, dark enough to read on periwinkle. */
  selectionFgWarn: "#6d3a06",

  // Primary and accent
  primary: "#aca3ec", // Periwinkle
  // The WOOP half of the wordmark. Its own token rather than `primary` so the
  // logo can be tuned without recolouring every accent in the interface.
  logo: "#aca3ec",
  secondary: "#818cf8", // Indigo 400
  accent: "#2dd4bf", // Teal 400

  // State colors
  successBase: "#34d399", // Emerald 400
  warningBase: "#fbbf24", // Amber 400
  dangerBase: "#f87171", // Red 400
  infoBase: "#60a5fa", // Blue 400

  // Agent/Tool colors
  agentBuild: "#818cf8", // Indigo 400
  agentExplore: "#2dd4bf", // Teal 400
  agentPlan: "#fbbf24", // Amber 400
  agentReview: "#f87171", // Red 400

  // Diff colors
  // Tints, not text colours: a changed line is a full-width band behind
  // syntax-highlighted code, so the background has to stay dark enough for the
  // highlighter's colours to read on top of it. Markers and counts are the
  // saturated pair.
  diffAdd: "#7dd3fc", // Sky 300 — the "+" marker
  diffRemove: "#f0a6bb", // Soft rose — the "−" marker
  diffAddHighlight: "#00ff00",
  diffRemoveHighlight: "#ff0000",
  diffAddBg: "#16293d",
  diffRemoveBg: "#3a1e2b",
  diffModified: "#fbbf24",
};

/**
 * The accent as a six-step ramp, lightest to darkest, stepped around `primary`.
 *
 * One ramp because there was already one written twice: the status spinner's
 * head/bloom/trail and the turn footer's pulse were the same six periwinkles in
 * different orders, in two files, free to drift apart. Anything that animates in
 * the accent reads it from here.
 */
export const primaryRamp = [
  "#c6c0f4", // bloom — one step lighter than the accent
  "#aca3ec", // primary
  "#8f83e0",
  "#7263ce",
  "#5a4cab",
  "#453b82",
] as const;

export const spacing = {
  xs: 0.5,
  sm: 1,
  md: 2,
  lg: 3,
  xl: 4,
};

export const typography = {
  fontSizeBase: 14,
  fontSizeSmall: 13,
  fontSizeLarge: 15,
  lineHeightNormal: 1.6,
  lineHeightLarge: 1.8,
};

// ─── Dimming ─────────────────────────────────────────────────────────────────
//
// A dialog floats over the app rather than replacing it, so the work behind it
// has to read as background. A terminal cannot apply a filter over what is
// already drawn, and ink's <Transform> cannot wrap a <Box> subtree, so the only
// way to fade the background is to render it in faded colours. Components read
// their palette from context instead of importing it, and the layer under a
// dialog is given the dimmed one.

export type Palette = typeof colors;

/** How far background colours travel toward the terminal background. */
export const DIM_AMOUNT = 0.6;

/** A hex colour as RGB channels, for anything that interpolates between two. */
export function parseHex(hex: string): [number, number, number] | null {
  const value = hex.trim().replace(/^#/, "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((channel) => channel + channel)
          .join("")
      : value;

  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;

  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * Moves a colour toward the terminal background by `amount` (0 = untouched,
 * 1 = invisible). Anything that is not a hex colour is returned unchanged, so a
 * named colour degrades to "not dimmed" rather than to a broken value.
 */
export function dimHex(hex: string, amount = DIM_AMOUNT): string {
  const parsed = parseHex(hex);
  if (!parsed) return hex;

  // bgCanvas, not bgBase: the target has to be the colour actually painted
  // behind the thing being faded, or "dimmed" lands short of the background and
  // the layer keeps a faint glow the rest of the frame does not have.
  const background = parseHex(colors.bgCanvas) ?? [0, 0, 0];
  const ratio = Math.min(Math.max(amount, 0), 1);
  const channel = (index: 0 | 1 | 2) =>
    Math.round(parsed[index] + (background[index] - parsed[index]) * ratio)
      .toString(16)
      .padStart(2, "0");

  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/** The whole palette, faded. Built once: it never changes at runtime. */
export const dimmedColors: Palette = Object.fromEntries(
  Object.entries(colors).map(([token, value]) => [token, dimHex(value)]),
) as Palette;

/**
 * Markdown body colours. Its own object because prose has roles the chrome does
 * not — a heading is not a "primary", it is a heading — and because it dims the
 * same way, assistant prose being most of what sits behind a dialog. But every
 * value is a token: these were One Dark purple, orange and peach, so the model's
 * reply was painted in a palette the interface around it did not share.
 */
export const markdownColors = {
  text: colors.textBase,
  heading: colors.primary,
  strong: colors.textStrong,
  emph: colors.secondary,
  code: colors.accent,
  link: colors.secondary,
  linkText: colors.accent,
  blockQuote: colors.borderStrong,
  listItem: colors.primary,
  listEnum: colors.secondary,
  hr: colors.borderBase,
} as const;

export type MarkdownPalette = { -readonly [K in keyof typeof markdownColors]: string };

export const dimmedMarkdownColors: MarkdownPalette = Object.fromEntries(
  Object.entries(markdownColors).map(([token, value]) => [token, dimHex(value)]),
) as MarkdownPalette;
