import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { usePalette } from "../styles/palette";

interface ToolStatusProps {
  status: "running" | "completed" | "failed";
}

export function ToolStatus({ status }: ToolStatusProps) {
  const colors = usePalette();

  if (status === "running") {
    return (
      <Text color={colors.primary}>
        <Spinner type="dots" />
      </Text>
    );
  }

  if (status === "completed") {
    return <Text color={colors.successBase}>✓</Text>;
  }

  if (status === "failed") {
    return <Text color={colors.dangerBase}>✗</Text>;
  }

  return null;
}
