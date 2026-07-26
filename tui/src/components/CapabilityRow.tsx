import { Box, Text } from "ink";
import { colors } from "../styles/theme";

export interface CapabilityRowProps {
  capabilities: readonly string[];
}

export function CapabilityRow({ capabilities }: CapabilityRowProps) {
  return (
    <Box flexWrap="wrap" justifyContent="center">
      {capabilities.map((capability, index) => (
        <Box key={capability} marginRight={index === capabilities.length - 1 ? 0 : 2}>
          <Text color="#475569">#{capability}</Text>
        </Box>
      ))}
    </Box>
  );
}
