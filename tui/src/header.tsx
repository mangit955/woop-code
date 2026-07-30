import { Box, Text } from "ink";
import { usePalette } from "./styles/palette";
import { planLayout } from "./layout";
import { useTerminalSize } from "./hooks/useTerminalSize";

interface HeaderProps {
  branch: string;
  provider: string;
}

export function Header({ branch, provider }: HeaderProps) {
  const colors = usePalette();

  const { width, height } = useTerminalSize();
  const layout = planLayout(width, height);

  // Both halves used to be free to wrap, so in a narrow terminal they ran into
  // each other and the header became two garbled rows. It stays one row now:
  // the tagline goes first, then the branch and provider.
  return (
    <Box justifyContent="space-between" width="100%" flexWrap="nowrap">
      <Box flexShrink={1} minWidth={0}>
        <Text bold color={colors.primary} wrap="truncate-end">
          Woopcode
        </Text>
        {layout.showHeaderTagline && (
          <Text color={colors.textMuted} wrap="truncate-end">
            {" / coding agent"}
          </Text>
        )}
      </Box>

      {layout.showHeaderMeta && (
        <Box flexShrink={0}>
          <Text color={colors.textMuted} wrap="truncate-end">
            {branch}
          </Text>
          <Text color={colors.textFaint}> · </Text>
          <Text color={colors.secondary} wrap="truncate-end">
            {provider}
          </Text>
        </Box>
      )}
    </Box>
  );
}
