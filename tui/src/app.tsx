import { Box } from "ink";
import { Header } from "./header";
import { Timeline } from "./timeline";
import { StatusBar } from "./statusBar";
import { Prompt } from "./prompt";
import { useUIStore } from "./store/useUIStore";
import type { AgentController } from "../../commands/agentController";

interface AppProps {
  controller: AgentController;
  onExit: () => Promise<void>;
}

export function App({ controller, onExit }: AppProps) {
  const state = useUIStore();

  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <Box marginBottom={1}>
        <Header />
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <Timeline items={state.timeline} />
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <StatusBar />
        <Prompt controller={controller} onExit={onExit} />
      </Box>
    </Box>
  );
}
