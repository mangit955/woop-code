import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { usePalette } from "../styles/palette";

/**
 * How many lines of output a block shows before it stops. Long enough for a
 * `git status` to be useful, short enough that one command cannot push the rest
 * of the conversation off the screen.
 */
const VISIBLE_OUTPUT_LINES = 12;
/** Tabs confuse width measurement, and git output is full of them. */
const TAB_WIDTH = 4;

export interface CommandBlockProps {
  command: string;
  output?: string;
  status: "running" | "completed" | "failed";
}

/**
 * A shell command as a card: the command, then what it printed.
 *
 * Command tools used to collapse to a single grey row like every other tool,
 * which hid the output the user most wants to see — the point of running
 * `git status` is the answer, not the fact that it ran.
 */
export function CommandBlock({ command, output, status }: CommandBlockProps) {
  const colors = usePalette();

  const lines = (output ?? "")
    .replace(/\s+$/, "")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ".repeat(TAB_WIDTH)));
  const hasOutput = output !== undefined && lines.some((line) => line.trim() !== "");
  const visible = hasOutput ? lines.slice(0, VISIBLE_OUTPUT_LINES) : [];
  const hidden = hasOutput ? Math.max(0, lines.length - visible.length) : 0;

  return (
    <Box flexDirection="row" marginBottom={1} flexShrink={0}>
      {/* A left border rather than a single character: it runs the full height of
          the block, marking the command and its output as one unit of work the
          way the user's own message is marked. */}
      <Box
        flexDirection="column"
        flexGrow={1}
        minWidth={0}
        backgroundColor={colors.bgLayer01}
        paddingX={1}
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeft
        borderColor={status === "failed" ? colors.dangerBase : colors.borderStrong}
      >
        <Box gap={1} flexShrink={0}>
          {status === "running" ? (
            <Text color={colors.primary}>
              <Spinner type="dots" />
            </Text>
          ) : (
            <Text color={status === "failed" ? colors.dangerBase : colors.textFaint}>$</Text>
          )}
          <Box flexShrink={1} minWidth={0}>
            <Text color={colors.textBase} wrap="truncate-end">
              {command}
            </Text>
          </Box>
        </Box>

        {hasOutput && (
          <Box flexDirection="column" marginTop={1} flexShrink={0}>
            {visible.map((line, index) => (
              <Text key={index} color={colors.textMuted} wrap="truncate-end">
                {line === "" ? " " : line}
              </Text>
            ))}
            {hidden > 0 && (
              <>
                <Text color={colors.textFaint}>…</Text>
                {/* Not "click to expand": there is nothing to click here, so it
                    says what was cut instead of promising an interaction. */}
                <Text color={colors.textFaint}>{`${hidden} more line${hidden === 1 ? "" : "s"}`}</Text>
              </>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
