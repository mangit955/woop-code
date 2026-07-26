import { Box, Text } from "ink";
import { colors } from "./styles/theme";

interface HeaderProps {
  branch: string;
  provider: string;
}

export function Header({ branch, provider }: HeaderProps) {
  return (
    <Box justifyContent="space-between" width="100%">
      <Box>
        <Text bold color={colors.primary}>
          Woopcode
        </Text>
        <Text color={colors.textMuted}> / coding agent</Text>
      </Box>

      <Box>
        <Text color={colors.textMuted}>{branch}</Text>
        <Text color={colors.textFaint}> · </Text>
        <Text color={colors.secondary}>{provider}</Text>
      </Box>
    </Box>
  );
}
