import { Box, measureElement, Text, type DOMElement, useInput } from "ink";
import { useEffect, useRef } from "react";
import type { PendingEdit } from "../types";
import { DiffViewer } from "./DiffViewer";
import { store } from "../store/ui-store";
import { useUIStore } from "../store/useUIStore";
import { usePalette } from "../styles/palette";
import { useTerminalSize } from "../hooks/useTerminalSize";

interface DiffPreviewProps {
  pendingEdit: PendingEdit;
}

export function DiffPreview({ pendingEdit }: DiffPreviewProps) {
  const colors = usePalette();

  const { pendingEditScrollOffset } = useUIStore();
  const { width, height } = useTerminalSize();
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!viewportRef.current || !contentRef.current) return;

      const viewportHeight = measureElement(viewportRef.current).height;
      const contentHeight = measureElement(contentRef.current).height;
      store.setPendingEditScrollLimit(contentHeight - viewportHeight);
    }, 0);

    return () => clearTimeout(timer);
  }, [pendingEdit.id, pendingEdit.diff, width, height]);

  useInput((input, key) => {
    if (key.upArrow) {
      store.scrollPendingEditBy(-1);
      return;
    }

    if (key.downArrow) {
      store.scrollPendingEditBy(1);
      return;
    }

    if (key.pageUp) {
      store.scrollPendingEditBy(-8);
      return;
    }

    if (key.pageDown) {
      store.scrollPendingEditBy(8);
      return;
    }

    if (key.home) {
      store.scrollPendingEditToStart();
      return;
    }

    if (key.end) {
      store.scrollPendingEditToEnd();
      return;
    }

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
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
    >
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        borderStyle="single"
        borderColor={colors.borderBase}
      >
        <Box justifyContent="space-between" paddingX={1} flexShrink={0}>
          <Box gap={1} flexShrink={1}>
            <Text color={colors.warningBase}>M</Text>
            <Text bold color={colors.textBase} wrap="truncate-end">
              {pendingEdit.filePath}
            </Text>
          </Box>
          <Box gap={1} flexShrink={0}>
            <Text color={colors.diffAdd}>+{additions}</Text>
            <Text color={colors.diffRemove}>−{deletions}</Text>
          </Box>
        </Box>
        <Box
          ref={viewportRef}
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          overflow="hidden"
        >
          <Box
            ref={contentRef}
            flexDirection="column"
            flexShrink={0}
            marginTop={-pendingEditScrollOffset}
          >
            <DiffViewer diff={pendingEdit.diff} />
          </Box>
        </Box>

        <Box
          justifyContent="space-between"
          paddingX={1}
          flexShrink={0}
          borderStyle="single"
          borderTop
          borderRight={false}
          borderBottom={false}
          borderLeft={false}
          borderColor={colors.borderBase}
        >
          <Text color={colors.textMuted}>
            <Text color={colors.dangerBase}>Esc</Text> reject · <Text color={colors.textFaint}>↑↓</Text> scroll
          </Text>
          <Text color={colors.textMuted}>
            <Text color={colors.successBase}>Enter</Text> apply
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
