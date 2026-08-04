import { Box, measureElement, Text, type DOMElement, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { PendingEdit } from "../types";
import { DiffViewer } from "./DiffViewer";
import { Scrollbar } from "./Scrollbar";
import { store } from "../store/ui-store";
import { useUIStore } from "../store/useUIStore";
import { usePalette } from "../styles/palette";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { planLayout } from "../layout";

interface DiffPreviewProps {
  pendingEdit: PendingEdit;
}

export function DiffPreview({ pendingEdit }: DiffPreviewProps) {
  const colors = usePalette();

  const { pendingEditScrollOffset } = useUIStore();
  const { width, height } = useTerminalSize();
  const layout = planLayout(width, height);
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const [measured, setMeasured] = useState({ content: 0, viewport: 0 });

  useEffect(() => {
    // Coalesced the way the conversation viewport's measurement is, rather than
    // taken once on a bare timeout: the panel is re-laid out by anything that
    // changes the rows around it, and a limit measured before that settles
    // leaves the diff either unscrollable or scrollable into blank space.
    const timer = setTimeout(() => {
      if (!viewportRef.current || !contentRef.current) return;

      const viewportHeight = measureElement(viewportRef.current).height;
      const contentHeight = measureElement(contentRef.current).height;
      store.setPendingEditScrollLimit(contentHeight - viewportHeight);
      setMeasured((current) =>
        current.content === contentHeight && current.viewport === viewportHeight
          ? current
          : { content: contentHeight, viewport: viewportHeight },
      );
    }, 75);

    return () => clearTimeout(timer);
  }, [pendingEdit.id, pendingEdit.diff, pendingEdit.filePath, width, height]);

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

    // Ink reports a chord's letter as plain input with a modifier flag, so
    // Ctrl+A would otherwise apply the edit and Ctrl+R reject it. Ctrl+A is
    // start-of-line in readline, which is an ordinary thing to press over a
    // composer. Only an unmodified letter is an answer here; chords belong to
    // the global handlers. Same guard as CommandApproval.
    const letter = key.ctrl || key.meta ? "" : input.toLowerCase();

    if (key.escape || letter === "r") {
      store.rejectPendingEdit();
      return;
    }

    if (key.return || letter === "a") {
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

  // An edit to a file that did not exist is a creation; say which one it is.
  const action = pendingEdit.oldContent === "" ? "Create" : "Edit";

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      paddingX={1}
    >
      {/* A filled panel rather than a bordered one: the diff reads as a card
          lifted off the transcript, which is how the rows' tints stay legible. */}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        backgroundColor={colors.bgLayer01}
        paddingY={1}
      >
        <Box justifyContent="space-between" paddingX={2} flexShrink={0} marginBottom={1}>
          <Box gap={1} flexShrink={1}>
            <Text color={colors.textFaint}>←</Text>
            <Text color={colors.textMuted}>{action}</Text>
            <Text bold color={colors.textBase} wrap="truncate-end">
              {pendingEdit.filePath}
            </Text>
          </Box>
          <Box gap={1} flexShrink={0}>
            <Text color={colors.diffAdd}>+{additions}</Text>
            <Text color={colors.diffRemove}>−{deletions}</Text>
          </Box>
        </Box>
        <Box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0} paddingRight={1}>
          <Box
            ref={viewportRef}
            flexDirection="column"
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            minWidth={0}
            overflow="hidden"
          >
            <Box
              ref={contentRef}
              flexDirection="column"
              flexShrink={0}
              marginTop={-pendingEditScrollOffset}
            >
              <DiffViewer diff={pendingEdit.diff} filePath={pendingEdit.filePath} />
            </Box>
          </Box>
          {/* This viewport scrolls top-down, so its offset is already the
              distance from the top — unlike the transcript's. */}
          {/* Always painted here, unlike the transcript's. A diff is a thing
              being judged rather than a stream being followed, and how much of
              it is still below the fold is part of the judgement. */}
          <Scrollbar
            contentHeight={measured.content}
            viewportHeight={measured.viewport}
            offsetFromTop={pendingEditScrollOffset}
            active
          />
        </Box>

        <Box justifyContent="space-between" paddingX={2} flexShrink={0} marginTop={1}>
          <Text color={colors.textMuted}>
            <Text color={colors.dangerBase}>Esc</Text> reject
            {layout.showDialogHints && (
              <>
                {" · "}
                <Text color={colors.textFaint}>↑↓ PgUp/PgDn</Text> scroll
              </>
            )}
          </Text>
          <Text color={colors.textMuted}>
            <Text color={colors.successBase}>Enter</Text> apply
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
