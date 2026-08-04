import { Box, Text } from "ink";
import { usePalette } from "../styles/palette";
import { scrollbarThumb } from "../scrollbar";

interface ScrollbarProps {
  contentHeight: number;
  viewportHeight: number;
  /** Rows between the top of the content and the first visible row. */
  offsetFromTop: number;
  /**
   * False while the viewport is pinned to the end of its content.
   *
   * A painted glyph on every row of the frame is not free: the gutter is
   * redrawn with each frame of a running turn, and measured, always painting it
   * took the app from 16KB of terminal output per three seconds to 50KB —
   * three times, while the agent works and the frame is changing anyway. Where
   * it earns that is when the reader has moved away from the end and needs to
   * know where they are; pinned to the latest line, the answer is "at the
   * bottom", which the transcript is already showing them.
   *
   * The column is reserved either way, so appearing costs no reflow.
   */
  active: boolean;
}

/** A one-column gutter saying where you are in something taller than the window. */
export function Scrollbar({
  contentHeight,
  viewportHeight,
  offsetFromTop,
  active,
}: ScrollbarProps) {
  const colors = usePalette();
  const thumb = scrollbarThumb(contentHeight, viewportHeight, offsetFromTop);

  // The column is held open even with nothing to draw in it. Trailing blanks
  // cost nothing to write, and the transcript keeps its width when the bar
  // arrives rather than reflowing under the reader mid-scroll.
  if (!thumb || !active) {
    return <Box flexShrink={0} marginLeft={1} width={1} />;
  }

  const below = viewportHeight - thumb.start - thumb.size;

  // The thumb has to be the brighter of the two, so `borderMuted` is the track
  // and not the thumb — `borderStrong` is darker than `textFaint` and would
  // draw the bar inside out.
  return (
    <Box flexDirection="column" flexShrink={0} marginLeft={1}>
      {thumb.start > 0 && <Text color={colors.borderMuted}>{stack("│", thumb.start)}</Text>}
      <Text color={colors.textFaint}>{stack("▐", thumb.size)}</Text>
      {below > 0 && <Text color={colors.borderMuted}>{stack("│", below)}</Text>}
    </Box>
  );
}

/** `count` rows of one glyph, as a single string. */
function stack(glyph: string, count: number) {
  return Array.from({ length: count }, () => glyph).join("\n");
}
