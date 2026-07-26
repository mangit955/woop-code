import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { colors } from "../styles/theme";

export function ThinkingIndicator() {
  return (
    <Box gap={1} paddingLeft={2}>
      <Text color={colors.textMuted}>
        <Spinner type="dots" />
      </Text>
      <Text color={colors.textMuted}>Thinking...</Text>
    </Box>
  );
}
