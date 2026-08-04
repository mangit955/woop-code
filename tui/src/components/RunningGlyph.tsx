import { Text } from "ink";
import { usePalette } from "../styles/palette";
import { useClock } from "../hooks/useClock";

/**
 * The braille cycle `ink-spinner` drew, on the app's shared clock.
 *
 * Same frames as `cli-spinners`' "dots", one third of a turn slower — the
 * shared clock ticks at 100ms where that spinner ran its own 80ms timer. What
 * it buys is that N running tools cost one commit between them instead of N
 * timers each repainting the whole frame on its own schedule.
 *
 * Isolated in its own component so only the animated glyph re-renders on a
 * tick, not the row that contains it.
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function RunningGlyph() {
  const colors = usePalette();
  const frame = useClock();

  return <Text color={colors.primary}>{FRAMES[frame % FRAMES.length]}</Text>;
}
