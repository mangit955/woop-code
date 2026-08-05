import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useMemo, useState } from "react";
import { getConfig, saveConfig } from "../../../config/config";
import { allModels, isRunnable, providerLabel } from "../../../providers/modelCatalog";
import type { AgentController } from "../../../commands/agentController";
import { store } from "../store/ui-store";
import { usePalette } from "../styles/palette";
import { planLayout, windowAround } from "../layout";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { applyModelSelection } from "../model-selection";

interface ModelPickerProps {
  controller: AgentController;
  selectedModel: string | null;
}

export function ModelPicker({ controller, selectedModel }: ModelPickerProps) {
  const colors = usePalette();
  const [query, setQuery] = useState("");
  const [showCursor, setShowCursor] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Every model whose provider has a client. A model listed as coming soon is
  // shown in `woopcode models`, where the point is the roadmap, but choosing one
  // here would set a selection that cannot run.
  const choices = useMemo(() => allModels().filter(isRunnable), []);
  const [selectedIndex, setSelectedIndex] = useState(() =>
    Math.max(0, choices.findIndex((model) => model.id === selectedModel)),
  );
  // Matched on the id as well as the name: "claude-opus-5" is a reasonable
  // thing to type, and with two providers listed the id is often what the user
  // has in hand.
  const matches = useMemo(() => {
    const needle = query.toLowerCase();
    return choices.filter(
      (model) =>
        model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle),
    );
  }, [choices, query]);
  const { width, height } = useTerminalSize();
  const layout = planLayout(width, height);
  // A message needs a row. Where the hints are on screen it takes their slot;
  // otherwise it costs the list a row, so the dialog still fits its budget
  // instead of pushing its own title off the top of a short terminal.
  const listRows = Math.max(
    1,
    layout.dialogListRows - (error && !layout.showDialogHints ? 1 : 0),
  );
  // The list is longer than a short terminal can show, so scroll a window of it
  // around the selection instead of rendering rows that get clipped away.
  const visible = windowAround(selectedIndex, matches.length, listRows);
  const hiddenAbove = visible.start;
  const hiddenBelow = matches.length - visible.end;

  useEffect(() => {
    const interval = setInterval(() => setShowCursor((visible) => !visible), 530);
    return () => clearInterval(interval);
  }, []);

  const close = () => store.closeModelPicker();
  const choose = async () => {
    const model = matches[selectedIndex];
    // A second Enter while the first save is in flight would write twice and
    // race over the outcome.
    if (!model || saving) return;

    setSaving(true);
    setError(null);

    const outcome = await applyModelSelection({
      modelId: model.id,
      isBusy: () => controller.isBusy(),
      setModel: (id) => controller.setModel(id),
      loadConfig: getConfig,
      saveConfig,
      // Closes the picker, so it runs only once everything else has succeeded.
      commit: (id) => store.setSelectedModel(id),
    });

    setSaving(false);
    // Anything other than success keeps the dialog open with a reason on it,
    // rather than dismissing silently or leaving it open with no explanation.
    if (outcome.status !== "applied") {
      setError(outcome.message);
      // The dialog has one narrow row for this, so keep the untruncated text
      // where it can still be read after the picker closes. Refusals are
      // self-explanatory and transient, so they stay in the dialog only.
      if (outcome.status === "failed") store.addSystemMessage(outcome.message);
    }
  };

  useInput((_, key) => {
    if (key.escape) {
      // Closing mid-write would hide the outcome of a save already in flight.
      if (!saving) close();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(matches.length - 1, current + 1));
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
        backgroundColor={colors.bgElevated}
        borderStyle={layout.showDialogBorder ? "round" : undefined}
        borderColor={colors.borderElevated}
      >
        <Box justifyContent="space-between" marginBottom={layout.dialogRhythm}>
          <Text bold color={colors.textStrong}>Select model</Text>
          {/* Reuses the hint's slot so progress costs no rows. */}
          <Text color={colors.textFaint}>{saving ? "saving…" : "esc"}</Text>
        </Box>
        <Box marginBottom={layout.dialogRhythm}>
          <TextInput
            value={query}
            placeholder="Search"
            showCursor={showCursor}
            onChange={(value) => {
              setQuery(value);
              setSelectedIndex(0);
              setShowCursor(true);
            }}
          />
        </Box>
        {layout.showDialogLabel && (
          <Text bold color={colors.secondary}>Recent</Text>
        )}
        <Box flexDirection="column" marginTop={layout.dialogRhythm}>
          {matches.length === 0 ? (
            <Text color={colors.textMuted}>No matching models</Text>
          ) : (
            <>
              {layout.showDialogScrollIndicators && hiddenAbove > 0 && (
                <Text color={colors.textFaint}>{`  ↑ ${hiddenAbove} more`}</Text>
              )}
              {matches.slice(visible.start, visible.end).map((model, offset) => {
                const index = visible.start + offset;
                const selected = index === selectedIndex;
                return (
                  <Box key={model.id} paddingX={1} backgroundColor={selected ? colors.selectionBg : undefined}>
                    <Text color={selected ? colors.selectionFg : colors.textMuted}>{selected ? "● " : "  "}</Text>
                    <Box flexShrink={1} minWidth={0}>
                      <Text bold={selected} color={selected ? colors.selectionFg : colors.textBase} wrap="truncate-end">
                        {model.name}
                      </Text>
                    </Box>
                    <Box flexGrow={1} />
                    {layout.dialogWidth >= 40 && (
                      <Text color={selected ? colors.selectionFg : colors.textFaint}>
                        {providerLabel(model.provider)}
                      </Text>
                    )}
                  </Box>
                );
              })}
              {layout.showDialogScrollIndicators && hiddenBelow > 0 && (
                <Text color={colors.textFaint}>{`  ↓ ${hiddenBelow} more`}</Text>
              )}
            </>
          )}
        </Box>
        {error ? (
          <Box marginTop={layout.showDialogHints ? 1 : 0}>
            <Text color={colors.dangerBase} wrap="truncate-end">
              {error}
            </Text>
          </Box>
        ) : (
          layout.showDialogHints && (
            <Box marginTop={2} gap={3}>
              <Text color={colors.textBase}>Enter select</Text>
              <Text color={colors.textFaint}>↑↓ navigate</Text>
            </Box>
          )
        )}
      </Box>
    </Box>
  );
}
