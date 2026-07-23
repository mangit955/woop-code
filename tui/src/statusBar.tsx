import { Box, Text } from "ink";
import { useUIStore } from "./store/useUIStore";

export function StatusBar() {
  const { status } = useUIStore();
  const state = getStatusState(status);

  return (
    <Box>
      <Text dimColor>status </Text>
      <Text color={state.color} dimColor={state.name === "idle"}>
        {state.label}
      </Text>
    </Box>
  );
}

function getStatusState(status: string) {
  const value = status.toLowerCase();

  if (value.includes("error") || value.includes("failed")) {
    return { name: "error", label: "Error", color: "red" } as const;
  }

  if (value.includes("cancelled")) {
    return { name: "cancelled", label: "Cancelled", color: undefined } as const;
  }

  if (value.includes("tool") || value.includes("running")) {
    return { name: "tool", label: "Running tool", color: "cyan" } as const;
  }

  if (value.includes("thinking")) {
    return { name: "thinking", label: "Thinking", color: "cyan" } as const;
  }

  return { name: "idle", label: "Idle", color: undefined } as const;
}
