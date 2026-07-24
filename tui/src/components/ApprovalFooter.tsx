import { Box, Text } from "ink";

export function ApprovalFooter() {
  return (
    <Box
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginTop={1}
      flexDirection="row"
      gap={2}
    >
      <Text color="green" bold>
        [A]
      </Text>
      <Text dimColor>Apply</Text>

      <Text color="red" bold>
        [R]
      </Text>
      <Text dimColor>Reject</Text>

      <Text color="gray" bold>
        [Esc]
      </Text>
      <Text dimColor>Cancel</Text>
    </Box>
  );
}
