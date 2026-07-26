import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useRef, useMemo, useState, useEffect } from "react";
import type { AgentController } from "../../commands/agentController";
import { handleSlashCommand } from "../../commands/slash";
import { registry } from "../../commands/slash/registry";
import { store } from "./store/ui-store";
import { colors } from "./styles/theme";
import { CommandPreview } from "./components/CommandPreview";

interface PromptProps {
  controller: AgentController;
  onExit: () => Promise<void>;
  value: string;
  placeholder?: string;
  onValueChange: (value: string) => void;
  providerName?: string;
  modelName?: string;
  variant?: "default" | "block";
}

export function Prompt({
  controller,
  onExit,
  value,
  placeholder,
  onValueChange,
  providerName,
  modelName,
  variant = "default",
}: PromptProps) {
  const isExiting = useRef(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showCursor, setShowCursor] = useState(true);
  const lastActivityTime = useRef(Date.now());

  useEffect(() => {
    const BLINK_INTERVAL = 530;
    const IDLE_TIMEOUT = 500;

    const timer = setInterval(() => {
      if (Date.now() - lastActivityTime.current < IDLE_TIMEOUT) {
        setShowCursor(true);
      } else {
        setShowCursor((prev) => !prev);
      }
    }, BLINK_INTERVAL);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [value]);

  const slashMatches = useMemo(() => {
    if (!value.startsWith("/")) return [];
    
    const search = value.slice(1).toLowerCase().trim();
    
    // If just "/", show all commands
    if (!search) return registry.getAll();
    
    return registry.getAll().filter(
      cmd => cmd.name.startsWith(search) || cmd.aliases?.some(a => a.startsWith(search))
    );
  }, [value]);

  const handleValueChange = (newValue: string) => {
    lastActivityTime.current = Date.now();
    setShowCursor(true);
    onValueChange(newValue);
  };

  useInput((input, key) => {
    lastActivityTime.current = Date.now();
    setShowCursor(true);

    if (value.startsWith("/") && slashMatches.length > 0) {
      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(Math.min(slashMatches.length, 5) - 1, prev + 1));
        return;
      }
    } else {
      if (key.upArrow || key.pageUp) {
        store.scrollUp();
        return;
      }
      if (key.downArrow || key.pageDown) {
        store.scrollDown();
        return;
      }
    }

    if (!(key.ctrl && input.toLowerCase() === "c")) {
      return;
    }

    if (controller.isBusy()) {
      controller.cancel();
      return;
    }

    if (!isExiting.current) {
      isExiting.current = true;
      void onExit();
    }
  });

  async function handleSubmit(input: string) {
    const prompt = input.trim();

    if (!prompt || controller.isBusy()) {
      return;
    }

    // Auto-complete the selected slash command
    if (prompt.startsWith("/") && slashMatches.length > 0) {
      const activeIndex = Math.min(selectedIndex, slashMatches.length - 1);
      const selected = slashMatches[activeIndex];
      if (selected && prompt !== `/${selected.name}`) {
         onValueChange(`/${selected.name} `);
         return;
      }
    }

    // 🔥 Slash command interception
    const context = {
      controller,
      onExit,
      onOutput: (message: string) => {
        store.addSystemMessage(message);
      },
    };

    const result = await handleSlashCommand(prompt, context);

    if (result.handled) {
      onValueChange("");
      return;
    }

    // Original flow
    if (prompt === "/exit") {
      await onExit();
      return;
    }

    onValueChange("");
    
    // Run the agent with error handling to keep app alive
    try {
      await controller.run(prompt);
    } catch (error) {
      // Error already displayed via callbacks.onError
      // Just catch it here to prevent app crash
      if (process.env.DEBUG) {
        console.error("Prompt handler caught error:", error);
      }
    }
  }

  if (variant === "default") {
    return (
      <Box flexDirection="column" width="100%" position="relative">
        {slashMatches.length > 0 && (
          <Box position="absolute" bottom={1} left={0} width="100%">
            <CommandPreview matches={slashMatches} query={value.slice(1)} selectedIndex={selectedIndex} />
          </Box>
        )}
        <Box>
          <Text color={colors.primary}>❯ </Text>
          <TextInput
            value={value}
            placeholder={placeholder}
            showCursor={showCursor}
            onChange={handleValueChange}
            onSubmit={handleSubmit}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      {slashMatches.length > 0 && (
        <Box position="absolute" bottom={4} left={0} width="100%">
          <CommandPreview matches={slashMatches} query={value.slice(1)} selectedIndex={selectedIndex} />
        </Box>
      )}
      <Box 
        backgroundColor="#1a1a1a" 
        flexDirection="row" 
        width="100%" 
        position="relative"
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={colors.primary}
      >
        <Box flexDirection="column" flexGrow={1} paddingY={1} paddingLeft={1} paddingRight={1}>
          <Box minHeight={1}>
            <TextInput
              value={value}
              placeholder={placeholder}
              showCursor={showCursor}
              onChange={handleValueChange}
              onSubmit={handleSubmit}
            />
          </Box>
          <Box marginTop={1}>
            <Text bold color={colors.textMuted}>Agent</Text>
            <Text color={colors.textFaint}>
              {" · "}{providerName ?? "Provider"} {modelName ?? "Model"}
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
