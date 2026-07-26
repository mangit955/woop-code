import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { colors } from "../styles/theme";

interface ToolStatusProps {
  status: "running" | "completed" | "failed";
}

export function ToolStatus({ status }: ToolStatusProps) {
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
