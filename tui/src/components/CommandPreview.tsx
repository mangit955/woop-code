import { Box, Text } from "ink";
import { colors } from "../styles/theme";
import { windowAround } from "../layout";
import type { SlashCommand } from "../../../commands/slash/types";

/** Rows the "COMMANDS" label and the gap under it occupy. */
const HEADER_ROWS = 2;
/** Rows the "↑ n more" / "↓ n more" pair occupies. */
const INDICATOR_ROWS = 2;
/** Below this there is no room to spend rows describing what is hidden. */
const MIN_ROWS_FOR_INDICATORS = 3;
const NAME_COLUMN_WIDTH = 20;

export interface CommandListPlan {
  /** Index range of the commands to render. */
  start: number;
  end: number;
  hiddenAbove: number;
  hiddenBelow: number;
  showIndicators: boolean;
  /** Whether the header fits; a tiny budget spends its rows on commands. */
  showHeader: boolean;
  /** Rows the popup will actually occupy, never more than `maxRows`. */
  rows: number;
}

/**
 * Divides the popup's row budget between the header, the scroll indicators and
 * the commands themselves. Pure, because the row arithmetic is the whole bug:
 * an unbounded list is what let this paint over the rest of the app.
 */
export function planCommandList({
  maxRows,
  showHeader,
  total,
  selectedIndex,
}: {
  maxRows: number;
  showHeader: boolean;
  total: number;
  selectedIndex: number;
}): CommandListPlan {
  // The header costs two rows and is worth nothing without a command under it.
  const withHeader = showHeader && maxRows >= HEADER_ROWS + 1;
  const headerRows = withHeader ? HEADER_ROWS : 0;
  const bodyRows = Math.max(1, maxRows - headerRows);
  // Indicators only earn their rows when there is enough left to list something.
  const showIndicators = bodyRows >= MIN_ROWS_FOR_INDICATORS && total > bodyRows;

  // Window around the selection so it is always visible, whether or not there
  // is room to say how much is hidden.
  let listRows = showIndicators ? bodyRows - INDICATOR_ROWS : bodyRows;
  let { start, end } = windowAround(selectedIndex, total, listRows);

  if (showIndicators) {
    // At the top or the bottom of the list only one indicator is needed, so
    // hand the spare row back rather than leaving it blank. Widening can only
    // reduce what is hidden, so the budget still holds.
    const needed = (start > 0 ? 1 : 0) + (total - end > 0 ? 1 : 0);
    if (needed < INDICATOR_ROWS) {
      listRows = bodyRows - needed;
      ({ start, end } = windowAround(selectedIndex, total, listRows));
    }
  }

  const hiddenAbove = start;
  const hiddenBelow = total - end;

  return {
    start,
    end,
    hiddenAbove,
    hiddenBelow,
    showIndicators,
    showHeader: withHeader,
    rows:
      headerRows +
      (end - start) +
      (showIndicators && hiddenAbove > 0 ? 1 : 0) +
      (showIndicators && hiddenBelow > 0 ? 1 : 0),
  };
}

export interface CommandPreviewProps {
  matches: SlashCommand[];
  query: string;
  selectedIndex: number;
  /** Total rows the popup may occupy, from the layout plan. */
  maxRows: number;
  showHeader?: boolean;
}

/**
 * The list is bounded and scrolls. It used to render every match at once inside
 * an absolutely positioned box, which took it out of layout: on a short terminal
 * it painted over the header and the wordmark, and clipped its own first rows —
 * so the selected command could be off screen while the arrows still moved
 * through it.
 */
export function CommandPreview({
  matches,
  query,
  selectedIndex,
  maxRows,
  showHeader = true,
}: CommandPreviewProps) {
  if (matches.length === 0) return null;

  const activeIndex = Math.min(selectedIndex, matches.length - 1);
  const visible = planCommandList({
    maxRows,
    showHeader,
    total: matches.length,
    selectedIndex: activeIndex,
  });
  const { hiddenAbove, hiddenBelow, showIndicators: useIndicators } = visible;

  return (
    <Box flexDirection="column" flexShrink={0} paddingX={1} backgroundColor="#1a1a1a">
      {visible.showHeader && (
        <Box marginBottom={1}>
          <Text color={colors.textFaint} bold>
            COMMANDS
          </Text>
        </Box>
      )}

      {useIndicators && hiddenAbove > 0 && (
        <Text color={colors.textFaint}>{` ↑ ${hiddenAbove} more`}</Text>
      )}

      {matches.slice(visible.start, visible.end).map((cmd, offset) => {
        const index = visible.start + offset;
        const isSelected = index === activeIndex;
        const aliases = cmd.aliases?.length
          ? ` (${cmd.aliases.map((alias) => `/${alias}`).join(", ")})`
          : "";

        return (
          <Box
            key={cmd.name}
            width="100%"
            height={1}
            flexShrink={0}
            paddingX={1}
            backgroundColor={isSelected ? "#fb923c" : undefined}
          >
            <Box width={NAME_COLUMN_WIDTH} flexShrink={0}>
              <Text color={isSelected ? "#000000" : colors.primary}>/</Text>
              <Text bold color={isSelected ? "#000000" : colors.textBase}>
                {cmd.name}
              </Text>
            </Box>
            <Text color={isSelected ? "#431407" : colors.textMuted} wrap="truncate-end">
              {cmd.description}
              {aliases}
            </Text>
          </Box>
        );
      })}

      {useIndicators && hiddenBelow > 0 && (
        <Text color={colors.textFaint}>{` ↓ ${hiddenBelow} more`}</Text>
      )}
    </Box>
  );
}
