import { Box, Text } from "ink";

interface HeaderProps {
  branch: string;
  provider: string;
}

export function Header({ branch, provider }: HeaderProps) {
  return (
    <Box justifyContent="space-between" width="100%">
      <Box>
        <Text bold color="cyan">
          Woopcode
        </Text>
        <Text dimColor> / coding agent</Text>
      </Box>

      <Box>
        <Text dimColor>{branch}</Text>
        <Text dimColor> · </Text>
        <Text color="cyan">{provider}</Text>
      </Box>
    </Box>
  );
}
