import React from "react";
import { Box, Text } from "ink";
import { useLogoAnimation } from "../hooks/useLogoAnimation";
import type { AnimationMode } from "../hooks/useLogoAnimation";

export interface LogoRevealProps {
  /** The text to animate */
  text: string;
  /** Animation duration in milliseconds (default: 600) */
  duration?: number;
  /** Animation style (default: "highlight") */
  mode?: AnimationMode;
  /** Color for highlighted characters (default: "cyan") */
  highlightColor?: string;
  /** Whether to show bold text (default: true) */
  bold?: boolean;
  /** Callback when animation completes */
  onComplete?: () => void;
}

/**
 * Premium animated logo reveal component for terminal UIs.
 * 
 * Supports three animation modes:
 * - "highlight" (default): Smooth left-to-right highlight sweep
 * - "typewriter": Classic character-by-character reveal
 * - "scan": Terminal boot-style scan line reveal
 */
export function LogoReveal({
  text,
  duration = 600,
  mode = "highlight",
  highlightColor = "cyan",
  bold = true,
  onComplete,
}: LogoRevealProps) {
  const { visibleText, highlightPosition, isComplete } = useLogoAnimation({
    text,
    duration,
    mode,
    onComplete,
  });

  // Render based on animation mode
  switch (mode) {
    case "typewriter":
      return (
        <Box>
          <Text bold={bold} color={highlightColor}>
            {visibleText}
          </Text>
          {!isComplete && <Text dimColor>_</Text>}
        </Box>
      );

    case "highlight":
      return (
        <Box>
          {renderHighlightSweep(text, highlightPosition, highlightColor, bold, isComplete)}
        </Box>
      );

    case "scan":
      return (
        <Box>
          {renderScanReveal(text, highlightPosition, highlightColor, bold, isComplete)}
        </Box>
      );

    default:
      return (
        <Box>
          <Text bold={bold} color={highlightColor}>
            {text}
          </Text>
        </Box>
      );
  }
}

/**
 * Render highlight sweep animation
 * Full text visible, highlight sweeps left-to-right
 */
function renderHighlightSweep(
  text: string,
  position: number,
  color: string,
  bold: boolean,
  isComplete: boolean
): React.ReactNode {
  if (isComplete) {
    // Final state: fully highlighted
    return (
      <Text bold={bold} color={color}>
        {text}
      </Text>
    );
  }

  // Calculate which characters are behind the sweep
  const sweepIndex = Math.floor(position * text.length);

  return (
    <>
      {/* Highlighted portion (characters behind sweep) */}
      <Text bold={bold} color={color}>
        {text.slice(0, sweepIndex)}
      </Text>
      {/* Dim portion (characters ahead of sweep) */}
      <Text bold={bold} dimColor>
        {text.slice(sweepIndex)}
      </Text>
    </>
  );
}

/**
 * Render scan reveal animation
 * Characters begin dim, scan line reveals them
 */
function renderScanReveal(
  text: string,
  position: number,
  color: string,
  bold: boolean,
  isComplete: boolean
): React.ReactNode {
  if (isComplete) {
    // Final state: fully revealed
    return (
      <Text bold={bold} color={color}>
        {text}
      </Text>
    );
  }

  const scanIndex = Math.floor(position * text.length);

  return (
    <>
      {/* Revealed portion */}
      <Text bold={bold} color={color}>
        {text.slice(0, scanIndex)}
      </Text>
      {/* Scan line character (if not at end) */}
      {scanIndex < text.length && (
        <Text bold={bold} color={color} backgroundColor="gray">
          {text[scanIndex]}
        </Text>
      )}
      {/* Unrevealed portion */}
      <Text bold={bold} dimColor>
        {text.slice(scanIndex + 1)}
      </Text>
    </>
  );
}
