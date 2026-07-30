import { Box, Text } from "ink";
import { usePalette } from "../styles/palette";
import { VERSION } from "../../../config/version";

export function HomeFooter() {
  const colors = usePalette();

  // The version comes from Woopcode's own package.json. Reading it from
  // process.cwd(), as this used to, showed the *user's* project version.
  const cwd = process.cwd().replace(process.env.HOME || "", "~");

  return (
    <Box width="100%" justifyContent="space-between" paddingX={1}>
      <Text color={colors.textFaint}>{cwd}</Text>
      <Text color={colors.textFaint}>{VERSION}</Text>
    </Box>
  );
}
