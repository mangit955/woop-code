import { Box, Text } from "ink";
import { usePalette } from "../styles/palette";
import { useClock } from "../hooks/useClock";
import { primaryRamp, type Palette } from "../styles/theme";
import { getModelDisplayName } from "../../../providers/client";
import type { TurnIdentity, TurnOutcome } from "../types";
import { planLayout } from "../layout";
import { sessionModeLabel } from "../../../runtime/planMode";
import { useTerminalSize } from "../hooks/useTerminalSize";

/**
 * Frames of the shared 100ms clock between pulse steps.
 *
 * Two rather than the 240ms this used to run at: the clock cannot be divided
 * into 240, and the elapsed time has to update every frame anyway to keep the
 * tenths digit honest, so the pulse costs nothing extra at 200ms.
 */
const PULSE_EVERY_FRAMES = 2;

/**
 * Breathes the marker while the turn is in flight: up the theme's accent ramp
 * and back down, so the pulse cannot drift away from the spinner beside it.
 */
const pulseColors = [
  primaryRamp[5],
  primaryRamp[3],
  primaryRamp[2],
  primaryRamp[1],
  primaryRamp[2],
  primaryRamp[3],
] as const;

/**
 * Takes the palette as an argument so it fades with the layer it renders in.
 *
 * A turn that completed is coloured by the mode it ran under, read from the
 * label the turn recorded when it started. That is history, not live state: a
 * plan turn stays amber in scrollback after the session has switched back, which
 * is the point — it says what that turn was allowed to do.
 */
function outcomeColor(outcome: TurnOutcome, colors: Palette, agent: string) {
  if (outcome === "cancelled") return colors.textMuted;
  if (outcome === "error") return colors.dangerBase;
  return agent === sessionModeLabel("plan") ? colors.agentPlan : colors.primary;
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

/**
 * Splits on whether the turn is still running, and the split is load-bearing.
 *
 * Only a running footer may subscribe to the clock. Context does not respect
 * `memo`, so a finished footer that read the clock would re-render on every
 * tick — and a long session holds hundreds of them, which is the cost the
 * shared clock exists to remove.
 */
export function TurnFooter(props: TurnFooterProps) {
  if (props.endedAt === null) return <RunningTurnFooter {...props} />;

  return (
    <TurnFooterRow
      {...props}
      elapsed={props.endedAt - props.startedAt}
      pulseFrame={null}
    />
  );
}

function RunningTurnFooter(props: TurnFooterProps) {
  const frame = useClock();

  // Read at render rather than held in state: the clock already re-renders this
  // component, so a second copy of "what time is it" would only be one more
  // thing to keep in step.
  return (
    <TurnFooterRow
      {...props}
      elapsed={Date.now() - props.startedAt}
      pulseFrame={frame}
    />
  );
}

function TurnFooterRow({
  agent,
  model,
  outcome,
  elapsed,
  pulseFrame,
}: TurnFooterProps & { elapsed: number; pulseFrame: number | null }) {
  const colors = usePalette();
  const { width, height } = useTerminalSize();
  const layout = planLayout(width, height);

  const markerColor =
    pulseFrame === null
      ? outcomeColor(outcome ?? "completed", colors, agent)
      : pulseColors[
          Math.floor(pulseFrame / PULSE_EVERY_FRAMES) % pulseColors.length
        ];

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
