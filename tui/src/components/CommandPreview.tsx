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

  // Limit to top 5 matches to not take over the screen
  const displayMatches = matches.slice(0, 5);
  // Ensure selectedIndex is within the displayed bounds
  const activeIndex = Math.min(selectedIndex, displayMatches.length - 1);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.borderMuted}
      paddingX={1}
      marginBottom={0}
    >
      <Box marginBottom={1}>
        <Text color={colors.textFaint} bold>COMMANDS</Text>
      </Box>
      
      {displayMatches.map((cmd, index) => {
        const isSelected = index === activeIndex;
        
        return (
          <Box key={cmd.name} width="100%" paddingX={1} backgroundColor={isSelected ? colors.primary : undefined}>
            <Box width={20}>
              <Text color={isSelected ? colors.bgBase : colors.primary}>/</Text>
              <Text bold color={isSelected ? colors.bgBase : colors.textBase}>{cmd.name}</Text>
            </Box>
            <Text color={isSelected ? colors.bgLayer02 : colors.textMuted}>{cmd.description}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
