import { Box, Text, useInput } from "ink";
import type { PendingEdit } from "../types";
import { DiffViewer } from "./DiffViewer";
import { store } from "../store/ui-store";
import { colors } from "../styles/theme";

interface DiffPreviewProps {
  pendingEdit: PendingEdit;
}

export function DiffPreview({ pendingEdit }: DiffPreviewProps) {
  useInput((input, key) => {
    if (key.escape || input.toLowerCase() === "r") {
      store.rejectPendingEdit();
      return;
    }

    if (key.return || input.toLowerCase() === "a") {
      store.approvePendingEdit();
    }
  });

  const additions = pendingEdit.diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .length;
  const deletions = pendingEdit.diff
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---"))
    .length;

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Box justifyContent="space-between" alignItems="center">
        <Box gap={1}>
          <Text bold color={colors.textStrong}>Review changes</Text>
          <Text color={colors.textFaint}>1 file</Text>
        </Box>
        <Box gap={1}>
          <Text color={colors.diffAdd}>+{additions}</Text>
          <Text color={colors.diffRemove}>−{deletions}</Text>
        </Box>
      </Box>

      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={colors.borderBase}
      >
        <Box justifyContent="space-between" paddingX={1}>
          <Box gap={1} flexShrink={1}>
            <Text color={colors.warningBase}>M</Text>
            <Text bold color={colors.textBase} wrap="truncate-end">
              {pendingEdit.filePath}
            </Text>
          </Box>
          <Text color={colors.textFaint}>unified</Text>
        </Box>
        <DiffViewer diff={pendingEdit.diff} />
      </Box>

      <Box
        justifyContent="space-between"
        paddingX={1}
        borderStyle="single"
        borderColor={colors.borderMuted}
      >
        <Text color={colors.textMuted}>
          <Text color={colors.dangerBase}>Esc</Text> reject
        </Text>
        <Text color={colors.textMuted}>
          <Text color={colors.successBase}>Enter</Text> apply
        </Text>
      </Box>
    </Box>
  );
}
