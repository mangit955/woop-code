import { Text } from "ink";
import Spinner from "ink-spinner";

interface ToolStatusProps {
  status: "running" | "completed" | "failed";
}

export function ToolStatus({ status }: ToolStatusProps) {
  if (status === "running") {
    return (
      <Text color="cyan">
        <Spinner type="dots" /> Running
      </Text>
    );
  }

  if (status === "completed") {
    return <Text color="green">✓ Completed</Text>;
  }

  if (status === "failed") {
    return <Text color="red">✗ Failed</Text>;
  }

  return null;
}
