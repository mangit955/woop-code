import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { saveApprovalMode } from "../../../config/config";
import { APPROVAL_MODES, type ApprovalMode } from "../../../runtime/approval";
import { store } from "../store/ui-store";
import { usePalette } from "../styles/palette";
import { planLayout } from "../layout";
import { useTerminalSize } from "../hooks/useTerminalSize";

interface ApprovalPickerProps {
  mode: ApprovalMode;
}

export function ApprovalPicker({ mode }: ApprovalPickerProps) {
  const colors = usePalette();
  const { width, height } = useTerminalSize();
  const layout = planLayout(width, height);
  const [selectedIndex, setSelectedIndex] = useState(() =>
    Math.max(0, APPROVAL_MODES.findIndex((entry) => entry.mode === mode)),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    const chosen = APPROVAL_MODES[selectedIndex];
    if (!chosen || saving) return;

    setSaving(true);
    setError(null);

    // Persist before applying, so a failed write leaves the session on the mode
    // its config still records rather than on a wider one.
    try {
      await saveApprovalMode(chosen.mode);
    } catch (cause) {
      setSaving(false);
      setError(
        `Could not save: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return;
    }

    setSaving(false);
    store.setApprovalMode(chosen.mode);
  };

  useInput((_, key) => {
    if (key.escape) {
      if (!saving) store.closeApprovalPicker();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(APPROVAL_MODES.length - 1, current + 1));
      return;
    }
    if (key.return) void choose();
  });

  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
      <Box
        flexDirection="column"
        width={layout.dialogWidth}
        paddingX={layout.dialogWidth < 40 ? 1 : 3}
        paddingY={1}
        backgroundColor="#101010"
      >
        <Box justifyContent="space-between" marginBottom={layout.dialogRhythm}>
          <Text bold color={colors.textStrong}>
            Approval mode
          </Text>
          <Text color={colors.textFaint}>{saving ? "saving…" : "esc"}</Text>
        </Box>

        <Box flexDirection="column">
          {APPROVAL_MODES.map((entry, index) => {
            const selected = index === selectedIndex;
            const active = entry.mode === mode;

            return (
              <Box key={entry.mode} flexDirection="column">
                <Box paddingX={1} backgroundColor={selected ? "#fb923c" : undefined}>
                  <Text color={selected ? "#000000" : colors.textMuted}>
                    {active ? "● " : "  "}
                  </Text>
                  <Box flexShrink={1} minWidth={0}>
                    <Text
                      bold={selected}
                      color={selected ? "#000000" : colors.textBase}
                      wrap="truncate-end"
                    >
                      {entry.label}
                    </Text>
                  </Box>
                  <Box flexGrow={1} />
                  {entry.unsafe && (
                    <Text color={selected ? "#7c2d12" : colors.warningBase}>unsafe</Text>
                  )}
                </Box>
                {/* The description only for the highlighted row: four of them at
                    once is a wall of text in a dialog this size. */}
                {selected && layout.showDialogLabel && (
                  <Box paddingX={3}>
                    <Text color={colors.textFaint} wrap="truncate-end">
                      {entry.description}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>

        {error ? (
          <Box marginTop={1}>
            <Text color={colors.dangerBase} wrap="truncate-end">
              {error}
            </Text>
          </Box>
        ) : (
          layout.showDialogHints && (
            <Box marginTop={1} gap={3}>
              <Text color={colors.textBase}>Enter select</Text>
              <Text color={colors.textFaint}>↑↓ navigate</Text>
            </Box>
          )
        )}
      </Box>
    </Box>
  );
}
