import { Box, Text } from "ink";
import { usePalette } from "../styles/palette";

export function ApprovalFooter() {
  const colors = usePalette();

  return (
    <Box
      borderStyle="round"
      borderColor={colors.warningBase}
      paddingX={1}
      marginTop={1}
      flexDirection="row"
      gap={2}
    >
      <Text color={colors.successBase} bold>
        [A]
      </Text>
      <Text color={colors.textFaint}>Apply</Text>

      <Text color={colors.dangerBase} bold>
        [R]
      </Text>
      <Text color={colors.textFaint}>Reject</Text>

      <Text color={colors.textMuted} bold>
        [Esc]
      </Text>
      <Text color={colors.textFaint}>Cancel</Text>
    </Box>
  );
}
