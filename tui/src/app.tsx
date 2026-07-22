import { Box, Text } from "ink";
import { Header } from "./header";
import { Timeline } from "./timeline";
import { StatusBar } from "./statusBar";
import { Prompt } from "./prompt";
import { useUIStore } from "./store/useUIStore";

export function App() {
  const state = useUIStore();

  return (
    <Box flexDirection="column" height="100%">
      <Header />
      <Text color="gray">{"─".repeat(process.stdout.columns || 80)}</Text>
      <Box flexDirection="column" flexGrow={1}>
        <Timeline items={state.timeline} />
      </Box>

      <StatusBar />
      <Prompt />
    </Box>
  );
}
