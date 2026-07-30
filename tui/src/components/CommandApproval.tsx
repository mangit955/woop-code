import { Box, Text, useInput } from "ink";
import type { PendingCommand } from "../types";
import { store } from "../store/ui-store";
import { colors } from "../styles/theme";

export function CommandApproval({ command }: { command: PendingCommand }) {
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

  const label = command.toolName === "run_tests" ? "Test command" : "Terminal command";
  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
      <Box flexDirection="column" width="80%" borderStyle="single" borderColor={colors.warningBase} paddingX={1}>
        <Text bold color={colors.warningBase}>Approve {label}</Text>
        <Text color={colors.textMuted}>This command may read, modify, or access network resources.</Text>
        <Box marginTop={1} paddingX={1} backgroundColor="#1a1a1a">
          <Text color={colors.textBase}>$ {command.command}</Text>
        </Box>
        <Box marginTop={1} justifyContent="space-between">
          <Text color={colors.textMuted}><Text color={colors.dangerBase}>Esc</Text> reject</Text>
          <Text color={colors.textMuted}><Text color={colors.successBase}>Enter</Text> run</Text>
        </Box>
      </Box>
    </Box>
  );
}
