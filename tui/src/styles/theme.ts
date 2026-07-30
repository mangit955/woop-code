/**
 * Theme configuration inspired by OpenCode's dark design system.
 * Uses a near-black base with a deep-blue primary, purple secondary, and
 * muted grays.
 */

export const colors = {
  // Text colors
  textBase: "#e5e5e5", // Neutral 200
  textMuted: "#a3a3a3", // Neutral 400
  textFaint: "#737373", // Neutral 500
  textStrong: "#ffffff",
  textAccent: "#3b82f6",
  textCode: "#2dd4bf", // Teal 400

  // Background colors
  bgBase: "#0a0a0a", // Neutral 950
  bgLayer01: "#171717", // Neutral 900
  bgLayer02: "#262626", // Neutral 800

  // Border colors
  borderBase: "#404040", // Neutral 700
  borderMuted: "#262626", // Neutral 800
  borderStrong: "#525252", // Neutral 600
  borderActive: "#3b82f6", // Blue 600

  // Primary and accent
  primary: "#3b82f6", // Blue 600
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

function parseHex(hex: string): [number, number, number] | null {
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

  const background = parseHex(colors.bgBase) ?? [0, 0, 0];
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
 * Markdown body colours. Separate from `colors` because they are a syntax
 * palette rather than a UI one, but they dim the same way — assistant prose is
 * most of what sits behind a dialog.
 */
export const markdownColors = {
  text: "#eeeeee",
  heading: "#9d7cd8",
  strong: "#f5a742",
  emph: "#e5c07b",
  code: "#7fd88f",
  link: "#fab283",
  linkText: "#56b6c2",
  blockQuote: "#e5c07b",
  listItem: "#fab283",
  listEnum: "#56b6c2",
  hr: "#808080",
} as const;

export type MarkdownPalette = { -readonly [K in keyof typeof markdownColors]: string };

export const dimmedMarkdownColors: MarkdownPalette = Object.fromEntries(
  Object.entries(markdownColors).map(([token, value]) => [token, dimHex(value)]),
) as MarkdownPalette;
