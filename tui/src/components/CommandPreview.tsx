import { Box, Text } from "ink";
import { colors } from "../styles/theme";
import type { SlashCommand } from "../../../commands/slash/types";

export interface CommandPreviewProps {
  matches: SlashCommand[];
  query: string;
  selectedIndex: number;
}

export function CommandPreview({ matches, query, selectedIndex }: CommandPreviewProps) {
  if (matches.length === 0) return null;

  const activeIndex = Math.min(selectedIndex, matches.length - 1);

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      marginBottom={0}
      backgroundColor="#1a1a1a"
    >
      <Box marginBottom={1}>
        <Text color={colors.textFaint} bold>COMMANDS</Text>
      </Box>
      
      {matches.map((cmd, index) => {
        const isSelected = index === activeIndex;
        const aliases = cmd.aliases?.length ? ` (${cmd.aliases.map((alias) => `/${alias}`).join(", ")})` : "";
        
        return (
          <Box
            key={cmd.name}
            width="100%"
            height={1}
            paddingX={1}
            backgroundColor={isSelected ? "#fb923c" : undefined}
          >
            <Box width={20} flexShrink={0}>
              <Text color={isSelected ? "#000000" : colors.primary}>/</Text>
              <Text bold color={isSelected ? "#000000" : colors.textBase}>{cmd.name}</Text>
            </Box>
            <Text color={isSelected ? "#431407" : colors.textMuted} wrap="truncate-end">
              {cmd.description}{aliases}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
