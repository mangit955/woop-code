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
  // OpenCode's default ANSI diff palette: normal colors for counts and
  // bright variants for the actual change markers.
  diffAdd: "#008000",
  diffRemove: "#800000",
  diffAddHighlight: "#00ff00",
  diffRemoveHighlight: "#ff0000",
  diffAddBg: "#082408",
  diffRemoveBg: "#240808",
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
