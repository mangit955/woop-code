import { Box, Text, useInput } from "ink";
import type { PendingEdit } from "../types";
import { DiffViewer } from "./DiffViewer";
import { store } from "../store/ui-store";
import { parseDiff } from "diff";

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

  // Calculate diff stats
  const lines = pendingEdit.diff.split("\n");
  const additions = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const deletions = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;

  // Extract filename parts for breadcrumb-style display
  const pathParts = pendingEdit.filePath.split("/");
  const filename = pathParts[pathParts.length - 1];
  const directory = pathParts.slice(0, -1).join("/");

  return (
    <Box flexDirection="column" paddingX={2}>
      {/* Header - keeping agent visible */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Proposed Changes</Text>
        <Text dimColor>
          1 file changed{" "}
          <Text color="green">+{additions}</Text>{" "}
          <Text color="red">-{deletions}</Text>
        </Text>
      </Box>

      {/* Separator - subtle, no borders */}
      <Text dimColor>{"─".repeat(60)}</Text>

      {/* File header - modern breadcrumb style */}
      <Box flexDirection="column" marginY={1}>
        {directory && <Text dimColor>{directory}/</Text>}
        <Text bold color="cyan">
          📄 {filename}
        </Text>
      </Box>

      {/* Diff content - no border, just content */}
      <DiffViewer diff={pendingEdit.diff} />

      {/* Footer separator */}
      <Text dimColor marginTop={1}>
        {"─".repeat(60)}
      </Text>

      {/* Modern footer - minimal, spacious */}
      <Box flexDirection="row" justifyContent="space-between" marginTop={1} paddingX={2}>
        <Text dimColor>
          <Text color="red">←</Text> Esc Reject
        </Text>
        <Text dimColor>
          Apply Enter <Text color="green">→</Text>
        </Text>
      </Box>
    </Box>
  );
}
