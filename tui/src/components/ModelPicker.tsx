import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useMemo, useState } from "react";
import { getConfig, saveConfig } from "../../../config/config";
import { GOOGLE_MODELS } from "../../../config/client";
import type { AgentController } from "../../../commands/agentController";
import { store } from "../store/ui-store";
import { colors } from "../styles/theme";
import { planLayout, windowAround } from "../layout";
import { useTerminalSize } from "../hooks/useTerminalSize";

interface ModelPickerProps {
  controller: AgentController;
  selectedModel: string | null;
}

export function ModelPicker({ controller, selectedModel }: ModelPickerProps) {
  const [query, setQuery] = useState("");
  const [showCursor, setShowCursor] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(() =>
    Math.max(0, GOOGLE_MODELS.findIndex((model) => model.id === selectedModel)),
  );
  const matches = useMemo(
    () => GOOGLE_MODELS.filter((model) => model.name.toLowerCase().includes(query.toLowerCase())),
    [query],
  );
  const { width, height } = useTerminalSize();
  const layout = planLayout(width, height);
  // The list is longer than a short terminal can show, so scroll a window of it
  // around the selection instead of rendering rows that get clipped away.
  const visible = windowAround(selectedIndex, matches.length, layout.dialogListRows);
  const hiddenAbove = visible.start;
  const hiddenBelow = matches.length - visible.end;

  useEffect(() => {
    const interval = setInterval(() => setShowCursor((visible) => !visible), 530);
    return () => clearInterval(interval);
  }, []);

  const close = () => store.closeModelPicker();
  const choose = async () => {
    const model = matches[selectedIndex];
    if (!model || !controller.setModel(model.id)) return;

    const config = await getConfig();
    config.selectedModel = model.id;
    await saveConfig(config);
    store.setSelectedModel(model.id);
  };

  useInput((_, key) => {
    if (key.escape) {
      close();
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
        backgroundColor="#101010"
      >
        <Box justifyContent="space-between" marginBottom={layout.dialogRhythm}>
          <Text bold color={colors.textStrong}>Select model</Text>
          <Text color={colors.textFaint}>esc</Text>
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
                  <Box key={model.id} paddingX={1} backgroundColor={selected ? "#fb923c" : undefined}>
                    <Text color={selected ? "#000000" : colors.textMuted}>{selected ? "● " : "  "}</Text>
                    <Box flexShrink={1} minWidth={0}>
                      <Text bold={selected} color={selected ? "#000000" : colors.textBase} wrap="truncate-end">
                        {model.name}
                      </Text>
                    </Box>
                    <Box flexGrow={1} />
                    {layout.dialogWidth >= 34 && (
                      <Text color={selected ? "#000000" : colors.textFaint}>Google</Text>
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
        {layout.showDialogHints && (
          <Box marginTop={2} gap={3}>
            <Text color={colors.textBase}>Enter select</Text>
            <Text color={colors.textFaint}>↑↓ navigate</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
