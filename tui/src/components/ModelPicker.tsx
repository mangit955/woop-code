import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useMemo, useState } from "react";
import { getConfig, saveConfig } from "../../../config/config";
import { GOOGLE_MODELS } from "../../../config/client";
import type { AgentController } from "../../../commands/agentController";
import { store } from "../store/ui-store";
import { colors } from "../styles/theme";

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
      <Box flexDirection="column" width={68} paddingX={3} paddingY={1} backgroundColor="#101010">
        <Box justifyContent="space-between" marginBottom={1}>
          <Text bold color={colors.textStrong}>Select model</Text>
          <Text color={colors.textFaint}>esc</Text>
        </Box>
        <Box marginBottom={1}>
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
        <Text bold color={colors.secondary}>Recent</Text>
        <Box flexDirection="column" marginTop={1}>
          {matches.length === 0 ? (
            <Text color={colors.textMuted}>No matching models</Text>
          ) : matches.map((model, index) => {
            const selected = index === selectedIndex;
            return (
              <Box key={model.id} paddingX={1} backgroundColor={selected ? "#fb923c" : undefined}>
                <Text color={selected ? "#000000" : colors.textMuted}>{selected ? "● " : "  "}</Text>
                <Text bold={selected} color={selected ? "#000000" : colors.textBase}>{model.name}</Text>
                <Box flexGrow={1} />
                <Text color={selected ? "#000000" : colors.textFaint}>Google</Text>
              </Box>
            );
          })}
        </Box>
        <Box marginTop={2} gap={3}>
          <Text color={colors.textBase}>Enter select</Text>
          <Text color={colors.textFaint}>↑↓ navigate</Text>
        </Box>
      </Box>
    </Box>
  );
}
