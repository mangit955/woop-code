import { Box, Text } from "ink";
import { usePalette } from "../styles/palette";

export interface CapabilityRowProps {
  capabilities: readonly string[];
}

export function CapabilityRow({ capabilities }: CapabilityRowProps) {
  const colors = usePalette();

  return (
    <Box flexWrap="wrap" justifyContent="center">
      {capabilities.map((capability, index) => (
        <Box key={capability} marginRight={index === capabilities.length - 1 ? 0 : 2}>
          <Text color={colors.borderStrong}>#{capability}</Text>
        </Box>
      ))}
    </Box>
  );
}
