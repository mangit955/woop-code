import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { usePalette } from "../styles/palette";
import type { Palette } from "../styles/theme";
import { getModelDisplayName } from "../../../config/client";
import type { TurnIdentity, TurnOutcome } from "../types";
import { planLayout } from "../layout";
import { useTerminalSize } from "../hooks/useTerminalSize";

/**
 * Fast enough that the tenths digit reads as a running clock, slow enough that
 * it costs a fraction of what streaming tokens already cost per second.
 */
const TICK_INTERVAL_MS = 100;
const PULSE_INTERVAL_MS = 240;

/** Breathes the marker while the turn is in flight. */
const pulseColors = ["#453B82", "#7263CE", "#8F83E0", "#ACA3EC", "#8F83E0", "#7263CE"] as const;

/** Takes the palette as an argument so it fades with the layer it renders in. */
function outcomeColor(outcome: TurnOutcome, colors: Palette) {
  if (outcome === "cancelled") return colors.textMuted;
  if (outcome === "error") return colors.dangerBase;
  return colors.primary;
}

/**
 * Under a minute the tenths matter — most turns live there and the digit is the
 * only sign the clock is moving. Past that they are noise.
 */
export function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, milliseconds) / 1000;

  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.floor(seconds % 60)}s`;
}

interface TurnFooterProps extends TurnIdentity {
  /** Null while the turn is running, which is what starts the clock. */
  endedAt: number | null;
  outcome: TurnOutcome | null;
}

export function TurnFooter({
  agent,
  model,
  startedAt,
  endedAt,
  outcome,
}: TurnFooterProps) {
  const colors = usePalette();

  const running = endedAt === null;
  const [now, setNow] = useState(() => Date.now());
  const [pulse, setPulse] = useState(0);
  const { width, height } = useTerminalSize();
  const layout = planLayout(width, height);

  useEffect(() => {
    if (!running) return;

    const clock = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    const breathing = setInterval(
      () => setPulse((frame) => (frame + 1) % pulseColors.length),
      PULSE_INTERVAL_MS,
    );

    return () => {
      clearInterval(clock);
      clearInterval(breathing);
    };
  }, [running]);

  const elapsed = (endedAt ?? now) - startedAt;
  const markerColor = running
    ? pulseColors[pulse]
    : outcomeColor(outcome ?? "completed", colors);

  // One row, always. Wrapping this split "Build · Gemini 2.5 Flash Lite · 3.5s"
  // across three lines in a narrow terminal; the model name gives up columns and
  // then disappears, while the agent and the clock stay.
  return (
    <Box flexDirection="row" gap={1} marginBottom={1} flexShrink={0} flexWrap="nowrap">
      <Text color={markerColor}>▪</Text>
      <Text bold color={colors.textBase}>
        {agent}
      </Text>
      {layout.showTurnModel && (
        <>
          <Text color={colors.textFaint}>·</Text>
          <Box flexShrink={1} minWidth={0}>
            <Text color={colors.textMuted} wrap="truncate-end">
              {getModelDisplayName(model)}
            </Text>
          </Box>
        </>
      )}
      <Text color={colors.textFaint}>·</Text>
      <Text color={colors.textMuted}>{formatDuration(elapsed)}</Text>
      {outcome === "cancelled" && (
        <>
          <Text color={colors.textFaint}>·</Text>
          <Text color={colors.textMuted}>cancelled</Text>
        </>
      )}
      {outcome === "error" && (
        <>
          <Text color={colors.textFaint}>·</Text>
          <Text color={colors.dangerBase}>failed</Text>
        </>
      )}
    </Box>
  );
}
