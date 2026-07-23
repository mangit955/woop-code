import { Box, Text } from "ink";

export function Header() {
  return (
    <Box justifyContent="space-between" width="100%">
      <Box>
        <Text bold color="cyan">
          Woopcode
        </Text>
        <Text dimColor> / coding agent</Text>
      </Box>

      <Box>
        <Text dimColor>main</Text>
        <Text dimColor> · </Text>
        <Text color="cyan">Gemini</Text>
      </Box>
    </Box>
  );
}
