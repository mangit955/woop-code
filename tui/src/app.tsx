import { Box, Text } from "ink";
import { Header } from "./header";
import { Timeline } from "./timeline";
import { ConnectedStatusBar } from "./statusBar";
import { Prompt } from "./prompt";
import { useUIStore } from "./store/useUIStore";
import { HomeScreen, type HomeScreenData } from "./components/HomeScreen";
import { DiffPreview } from "./components/DiffPreview";
import type { AgentController } from "../../commands/agentController";
import { useState } from "react";
import { useTerminalSize } from "./hooks/useTerminalSize";
import { colors } from "./styles/theme";

interface AppProps {
  controller: AgentController;
  onExit: () => Promise<void>;
  homeScreen: HomeScreenData;
}

export function App({ controller, onExit, homeScreen }: AppProps) {
  const state = useUIStore();
  const [promptValue, setPromptValue] = useState("");
  const { width, height } = useTerminalSize();
  const showHome = state.timeline.length === 0;
  const hasPendingEdit = state.pendingEdit !== null;

  const promptProps = {
    controller,
    onExit,
    value: promptValue,
    onValueChange: setPromptValue,
    providerName: homeScreen.providerName,
    modelName: homeScreen.provider,
  };

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      backgroundColor="#000000"
    >
      {/* Header — pinned at top */}
      <Box flexShrink={0} paddingX={1}>
        <Header branch={homeScreen.branch} provider={homeScreen.providerName} />
      </Box>

      {/* Main content */}
      <Box flexDirection="column" flexGrow={1} minHeight={0} paddingX={1}>
        {showHome ? (
          <HomeScreen
            {...homeScreen}
            renderPrompt={(placeholder) => (
              <Prompt {...promptProps} placeholder={placeholder} variant="block" />
            )}
          />
        ) : hasPendingEdit ? (
          /* Split layout: Timeline on top, Diff below */
          <Box flexDirection="column" flexGrow={1} minHeight={0}>
            <Box flexDirection="column-reverse" flexShrink={1} overflow="hidden">
              <Box flexGrow={1} />
              <Box flexDirection="column" flexShrink={0} marginBottom={-(state.scrollOffset || 0)}>
                <Timeline items={state.timeline} isThinking={state.isThinking} />
              </Box>
            </Box>

            {/* Diff preview - takes remaining space */}
            <Box flexDirection="column" flexGrow={1} minHeight={0} marginTop={1}>
              <DiffPreview pendingEdit={state.pendingEdit!} />
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column-reverse" flexGrow={1} minHeight={0} overflow="hidden">
            <Box flexGrow={1} />
            <Box flexDirection="column" flexShrink={0} marginBottom={-(state.scrollOffset || 0)}>
              <Timeline items={state.timeline} isThinking={state.isThinking} />
            </Box>
          </Box>
        )}
      </Box>

      {/* Footer — pinned at bottom */}
      {!showHome && !hasPendingEdit && (
        <Box flexDirection="column" flexShrink={0} paddingX={1} gap={1} marginBottom={1}>
          <Prompt {...promptProps} variant="block" />
          <ConnectedStatusBar />
        </Box>
      )}
    </Box>
  );
}
