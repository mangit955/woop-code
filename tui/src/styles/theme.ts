/**
 * Theme configuration inspired by OpenCode's dark design system.
 * Uses OpenCode's warm dark palette: near-black bg, warm orange primary,
 * purple accent, cool blue secondary, and muted grays.
 */

export const colors = {
  // Text colors
  textBase: "#e2e8f0",      // Slate 200 (cooler white)
  textMuted: "#94a3b8",     // Slate 400 (cool gray)
  textFaint: "#64748b",     // Slate 500
  textStrong: "#ffffff",
  textAccent: "#38bdf8",    // Sky 400 (cool blue)
  textCode: "#2dd4bf",      // Teal 400

  // Background colors
  bgBase: "#020617",        // Slate 950 (cool near-black)
  bgLayer01: "#0f172a",     // Slate 900
  bgLayer02: "#1e293b",     // Slate 800

  // Border colors
  borderBase: "#334155",    // Slate 700
  borderMuted: "#1e293b",   // Slate 800
  borderStrong: "#475569",  // Slate 600
  borderActive: "#38bdf8",  // Sky 400

  // Primary and accent
  primary: "#38bdf8",       // Sky 400 - primary cyan/blue
  secondary: "#818cf8",     // Indigo 400
  accent: "#2dd4bf",        // Teal 400

  // State colors
  successBase: "#34d399",   // Emerald 400
  warningBase: "#fbbf24",   // Amber 400
  dangerBase: "#f87171",    // Red 400
  infoBase: "#60a5fa",      // Blue 400

  // Agent/Tool colors
  agentBuild: "#818cf8",    // Indigo 400
  agentExplore: "#2dd4bf",  // Teal 400
  agentPlan: "#fbbf24",     // Amber 400
  agentReview: "#f87171",   // Red 400

  // Diff colors
  diffAdd: "#34d399",
  diffRemove: "#f87171",
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
