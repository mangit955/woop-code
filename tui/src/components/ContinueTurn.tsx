import { Box, Text, useInput } from "ink";
import type { PendingContinuation } from "../types";
import { store } from "../store/ui-store";
import { usePalette } from "../styles/palette";
import { planLayout } from "../layout";
import { useTerminalSize } from "../hooks/useTerminalSize";

/**
 * The checkpoint a turn reaches when it has spent its step budget.
 *
 * This used to be an error: the loop threw, the footer said `failed`, and the
 * explanation went to a status that cleared after three seconds — for a turn
 * that had not broken and whose edits were already on disk. Asking instead puts
 * the decision where the information is, and is what lets the ceiling be
 * generous without letting a stuck loop run unwatched.
 */
export function ContinueTurn({ continuation }: { continuation: PendingContinuation }) {
  const colors = usePalette();
  const { width, height } = useTerminalSize();
  const layout = planLayout(width, height);

  useInput((input, key) => {
    // Ink reports a chord's letter as plain input with a modifier flag, so
    // Ctrl+C would otherwise read as "continue" here — and Ctrl+C means stop
    // the agent, which useCancelKey owns. Only an unmodified letter answers.
    const letter = key.ctrl || key.meta ? "" : input.toLowerCase();

    if (key.return || letter === "c") {
      store.continuePendingTurn();
    } else if (key.escape || letter === "s") {
      store.stopPendingTurn();
    }
  });

  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
      {/* Shaped like the command approval: title row, the thing being decided,
          then the keys. */}
      <Box
        flexDirection="column"
        width={layout.dialogWidth}
        paddingX={layout.dialogWidth < 40 ? 1 : 3}
        paddingY={1}
        backgroundColor="#101010"
      >
        <Box justifyContent="space-between" marginBottom={layout.dialogRhythm}>
          <Text bold color={colors.textStrong}>
            Still working
          </Text>
          <Text color={colors.textFaint}>esc</Text>
        </Box>

        <Box flexDirection="column" flexShrink={0}>
          <Text color={colors.textBase} wrap="truncate-end">
            {`${continuation.steps} steps used, and the turn is not finished.`}
          </Text>
          {/* Said plainly because the old failure implied otherwise: nothing is
              lost by stopping here. */}
          <Text color={colors.textMuted} wrap="truncate-end">
            Work done so far is already saved either way.
          </Text>
        </Box>

        {layout.showDialogHints && (
          <Box marginTop={1} justifyContent="space-between">
            <Text color={colors.textMuted}>
              <Text color={colors.dangerBase}>Esc</Text> stop here
            </Text>
            <Text color={colors.textMuted}>
              <Text color={colors.successBase}>Enter</Text> keep going
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
