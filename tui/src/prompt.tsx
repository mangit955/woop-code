import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useRef, useMemo, useState, useEffect } from "react";
import type { AgentController } from "../../commands/agentController";
import { handleSlashCommand } from "../../commands/slash";
import { registry } from "../../commands/slash/registry";
import { matchCommands } from "../../commands/slash/match";
import { store } from "./store/ui-store";
import { useUIStore } from "./store/useUIStore";
import { sessionModeColor, sessionModeLabel } from "../../runtime/planMode";
import { usePalette } from "./styles/palette";
import { CommandPreview } from "./components/CommandPreview";
import { planLayout } from "./layout";
import { useTerminalSize } from "./hooks/useTerminalSize";

interface PromptProps {
  controller: AgentController;
  onExit: () => Promise<void>;
  value: string;
  placeholder?: string;
  onValueChange: (value: string) => void;
  providerName?: string;
  modelName?: string;
  variant?: "default" | "inline" | "block";
  /** Dropped first when the composer runs out of columns. */
  showProvider?: boolean;
  /**
   * False while a dialog is open. The composer stays visible underneath one, so
   * it has to stop consuming keystrokes that belong to the dialog.
   */
  inputActive?: boolean;
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
  showProvider = true,
  inputActive = true,
}: PromptProps) {
  const colors = usePalette();
  const { sessionMode } = useUIStore();
  const planning = sessionMode === "plan";
  const modeColor = sessionModeColor(sessionMode, colors);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showCursor, setShowCursor] = useState(true);
  const { width, height } = useTerminalSize();
  const layout = planLayout(width, height);
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

  const slashMatches = useMemo(() => matchCommands(value), [value]);

  const handleValueChange = (newValue: string) => {
    lastActivityTime.current = Date.now();
    setShowCursor(true);
    onValueChange(newValue);
  };

  useInput(
    (input, key) => {
      lastActivityTime.current = Date.now();
      setShowCursor(true);

      // Tab cycles Build ⇄ Plan. The controller is authoritative and the store
      // mirrors it, the same way the model picker applies a choice.
      //
      // Safe to claim: ink-text-input ignores Tab, and this handler is inactive
      // while a dialog owns the screen. It is not slash completion either —
      // Enter already does that, from the highlighted row.
      if (key.tab) {
        store.setSessionMode(controller.toggleSessionMode());
        return;
      }

      if (value.startsWith("/") && slashMatches.length > 0) {
        if (key.upArrow) {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedIndex((prev) => Math.min(slashMatches.length - 1, prev + 1));
          return;
        }
      } else {
        if (key.upArrow) {
          store.scrollUp();
          return;
        }
        if (key.downArrow) {
          store.scrollDown();
          return;
        }
        if (key.pageUp) {
          store.pageUp();
          return;
        }
        if (key.pageDown) {
          store.pageDown();
          return;
        }
        if (key.home) {
          store.scrollToTop();
          return;
        }
        if (key.end) {
          store.resetScroll();
          return;
        }
      }

      // Ctrl+C is deliberately not handled here. It belongs to useCancelKey on
      // App, which stays mounted when a modal replaces this composer — ink would
      // otherwise run both handlers for a single press.
    },
    { isActive: inputActive }
  );

  async function handleSubmit(input: string) {
    const prompt = input.trim();

    if (!prompt || controller.isBusy()) {
      return;
    }

    if (prompt === "/models" || prompt === "/model" || prompt === "/m") {
      store.openModelPicker();
      onValueChange("");
      return;
    }

    if (prompt === "/approval" || prompt === "/approve") {
      store.openApprovalPicker();
      onValueChange("");
      return;
    }

    // Auto-complete the selected slash command
    if (prompt.startsWith("/") && slashMatches.length > 0) {
      const activeIndex = Math.min(selectedIndex, slashMatches.length - 1);
      const selected = slashMatches[activeIndex];
      const commandToken = prompt.slice(1).trim().split(/\s+/, 1)[0] ?? "";
      const isExactCommand = registry.get(commandToken) !== undefined;
      if (selected && !isExactCommand) {
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

  if (variant === "default" || variant === "inline") {
    return (
      <Box flexDirection="column" width="100%">
        {/* In flow, above the input: the popup gives way to the header and the
            transcript instead of painting over them. */}
        {slashMatches.length > 0 && (
          <CommandPreview
            matches={slashMatches}
            query={value.slice(1)}
            selectedIndex={selectedIndex}
            maxRows={layout.commandPopupRows}
            showHeader={layout.showCommandPopupHeader}
          />
        )}
        <Box>
          {/* These variants have no label row, so the mode rides on the caret —
              shown only while planning, leaving Build exactly as it was. */}
          {planning && <Text color={modeColor}>{sessionModeLabel(sessionMode)} </Text>}
          <Text color={modeColor}>❯ </Text>
          <TextInput
            value={value}
            placeholder={placeholder}
            showCursor={showCursor}
            focus={inputActive}
            onChange={handleValueChange}
            onSubmit={handleSubmit}
          />
        </Box>
      </Box>
    );
  }

  return (
    // No border on the outer box. It used to draw a bottom one in #000000, which
    // is invisible against the background but still occupies a row — so the block
    // carried on for a line past where the bar stopped, and the card looked
    // detached from its own edge.
    <Box flexDirection="column" width="100%">
      {slashMatches.length > 0 && (
        <CommandPreview
          matches={slashMatches}
          query={value.slice(1)}
          selectedIndex={selectedIndex}
          maxRows={layout.commandPopupRows}
          showHeader={layout.showCommandPopupHeader}
        />
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
        // The one column of the card that says which mode a keystroke lands in.
        borderColor={modeColor}
      >
        <Box
          flexDirection="column"
          flexGrow={1}
          paddingTop={1}
          paddingLeft={1}
          paddingRight={1}
        >
          <Box minHeight={1}>
            <TextInput
              value={value}
              placeholder={placeholder}
              showCursor={showCursor}
              focus={inputActive}
              onChange={handleValueChange}
              onSubmit={handleSubmit}
            />
          </Box>
          {/* One row, never two: wrapping this line used to push the model name
              through the card's bottom border. The agent label stays whole and
              the model name gives up characters instead. */}
          <Box marginTop={1} flexDirection="row" flexWrap="nowrap">
            <Box flexShrink={0}>
              {/* Amber while planning, and the same amber as the bar beside it:
                  the mode is the one thing on this row that changes what a
                  keystroke will do, so it should be legible without reading the
                  word. */}
              <Text color={modeColor}>{sessionModeLabel(sessionMode)}</Text>
              <Text color={colors.textFaint}>{" · "}</Text>
            </Box>
            <Box flexShrink={1} minWidth={0}>
              <Text color={colors.textBase} wrap="truncate-end">
                {modelName ?? "Model"}
              </Text>
            </Box>
            {showProvider && (
              <Box flexShrink={0}>
                <Text color={colors.textFaint}> Google</Text>
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
