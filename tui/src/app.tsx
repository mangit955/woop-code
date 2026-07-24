import { Box } from "ink";
import { Header } from "./header";
import { Timeline } from "./timeline";
import { ConnectedStatusBar } from "./statusBar";
import { Prompt } from "./prompt";
import { useUIStore } from "./store/useUIStore";
import { HomeScreen, type HomeScreenData } from "./components/HomeScreen";
import { DiffPreview } from "./components/DiffPreview";
import type { AgentController } from "../../commands/agentController";
import { useState } from "react";

interface AppProps {
  controller: AgentController;
  onExit: () => Promise<void>;
  homeScreen: HomeScreenData;
}

export function App({ controller, onExit, homeScreen }: AppProps) {
  const state = useUIStore();
  const [promptValue, setPromptValue] = useState("");
  const showHome = state.timeline.length === 0;
  const hasPendingEdit = state.pendingEdit !== null;

  const promptProps = {
    controller,
    onExit,
    value: promptValue,
    onValueChange: setPromptValue,
  };

  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <Box marginBottom={1}>
        <Header branch={homeScreen.branch} provider={homeScreen.providerName} />
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {hasPendingEdit ? (
          <DiffPreview pendingEdit={state.pendingEdit!} />
        ) : showHome ? (
          <HomeScreen
            {...homeScreen}
            renderPrompt={(placeholder) => (
              <Prompt {...promptProps} placeholder={placeholder} />
            )}
          />
        ) : (
          <Timeline items={state.timeline} isThinking={state.isThinking} />
        )}
      </Box>

      {!showHome && !hasPendingEdit && (
        <Box flexDirection="column" marginTop={1}>
          <ConnectedStatusBar />
          <Prompt {...promptProps} />
        </Box>
      )}
    </Box>
  );
}
