import { Box, Text, useInput } from "ink";
import type { PendingEdit } from "../types";
import { DiffViewer } from "./DiffViewer";
import { ApprovalFooter } from "./ApprovalFooter";
import { store } from "../store/ui-store";

interface DiffPreviewProps {
  pendingEdit: PendingEdit;
}

export function DiffPreview({ pendingEdit }: DiffPreviewProps) {
  useInput((input, key) => {
    if (key.escape) {
      store.clearPendingEdit();
      return;
    }

    const lowerInput = input.toLowerCase();

    if (lowerInput === "a") {
      store.approvePendingEdit();
    } else if (lowerInput === "r") {
      store.rejectPendingEdit();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box
        borderStyle="round"
        borderColor="blue"
        flexDirection="column"
        paddingX={1}
      >
        <Text bold color="blue">
          File Change Preview
        </Text>
        <Text dimColor>{pendingEdit.filePath}</Text>

        <DiffViewer diff={pendingEdit.diff} />
      </Box>

      <ApprovalFooter />
    </Box>
  );
}
