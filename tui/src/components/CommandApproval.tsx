import { Box, Text, useInput } from "ink";
import type { PendingCommand } from "../types";
import { store } from "../store/ui-store";
import { usePalette } from "../styles/palette";
import { planLayout } from "../layout";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { CommandRisk, describeRisk } from "../../../runtime/approval";

/** Warn only where the risk is what stopped the command. */
const RISK_IS_SEVERE = (risk: CommandRisk | undefined) =>
  risk === CommandRisk.DESTRUCTIVE || risk === CommandRisk.SYSTEM;

export function CommandApproval({ command }: { command: PendingCommand }) {
  const colors = usePalette();
  const { width, height } = useTerminalSize();
  const layout = planLayout(width, height);

  useInput((input, key) => {
    // Ink reports a chord's letter as plain input with a modifier flag, so
    // Ctrl+A would otherwise approve the command and Ctrl+R reject it. Only an
    // unmodified letter is an answer here; chords belong to global handlers.
    const letter = key.ctrl || key.meta ? "" : input.toLowerCase();

    if (key.return || letter === "a") {
      store.approvePendingCommand();
    } else if (key.escape || letter === "r") {
      store.rejectPendingCommand();
    }
  });

  const severe = RISK_IS_SEVERE(command.risk);
  const label = command.toolName === "run_tests" ? "Run tests" : "Run command";
  const accent = severe ? colors.dangerBase : colors.warningBase;

  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
      {/* Opaque, and shaped like the other dialogs: title row, the thing being
          decided, then the keys. The transcript stays visible around it. */}
      <Box
        flexDirection="column"
        width={layout.dialogWidth}
        paddingX={layout.dialogWidth < 40 ? 1 : 3}
        paddingY={1}
        backgroundColor={colors.bgElevated}
        borderStyle={layout.showDialogBorder ? "round" : undefined}
        borderColor={colors.borderElevated}
      >
        <Box justifyContent="space-between" marginBottom={layout.dialogRhythm}>
          <Text bold color={colors.textStrong}>
            {label}
          </Text>
          <Text color={colors.textFaint}>esc</Text>
        </Box>

        {/* The command itself, as it will be run. */}
        <Box paddingX={1} backgroundColor={colors.bgInset} flexShrink={0}>
          <Text color={colors.textFaint}>{"$ "}</Text>
          <Box flexShrink={1} minWidth={0}>
            <Text color={colors.textBase} wrap="truncate-end">
              {command.command}
            </Text>
          </Box>
        </Box>

        {/* Why it stopped: the classifier already knows, and a reader deciding
            in one keystroke deserves the reason rather than a generic warning. */}
        {command.risk !== undefined && (
          <Box marginTop={layout.dialogRhythm}>
            <Text color={accent} wrap="truncate-end">
              {severe ? "⚠ " : ""}
              {describeRisk(command.risk)}
            </Text>
          </Box>
        )}

        {layout.showDialogHints && (
          <Box marginTop={1} justifyContent="space-between">
            <Text color={colors.textMuted}>
              <Text color={colors.dangerBase}>Esc</Text> reject
            </Text>
            <Text color={colors.textMuted}>
              <Text color={colors.successBase}>Enter</Text> run
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
