import { Box, Text } from "ink";
import { usePalette } from "../styles/palette";

export interface CapabilityRowProps {
  capabilities: readonly string[];
}

/**
 * What the agent does, under the wordmark.
 *
 * Separated by the same middle dot the header, the composer and the turn footer
 * use. These were `#Build  #Plan  #Review` — hashtags, which say "tag" to a
 * reader who has met them anywhere else, and which nothing on any other screen
 * matched.
 */
export function CapabilityRow({ capabilities }: CapabilityRowProps) {
  const colors = usePalette();

  return (
    <Box flexWrap="wrap" justifyContent="center">
      {capabilities.map((capability, index) => (
        <Box key={capability}>
          {index > 0 && <Text color={colors.borderStrong}>{" · "}</Text>}
          <Text color={colors.textFaint}>{capability}</Text>
        </Box>
      ))}
    </Box>
  );
}
