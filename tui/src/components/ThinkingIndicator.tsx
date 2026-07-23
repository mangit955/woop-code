import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export function ThinkingIndicator() {
  return (
    <Box gap={1}>
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>

      <Text color="gray">Thinking...</Text>
    </Box>
  );
}
