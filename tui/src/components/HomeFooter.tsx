import { Box, Text } from "ink";
import { colors } from "../styles/theme";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function HomeFooter() {
  const cwd = process.cwd().replace(process.env.HOME || "", "~");
  
  let version = "0.3.3";
  try {
    const pkgStr = readFileSync(join(process.cwd(), "package.json"), "utf8");
    const pkg = JSON.parse(pkgStr);
    if (pkg.version) version = pkg.version;
  } catch (e) {
    // fallback
  }

  return (
    <Box width="100%" justifyContent="space-between" paddingX={1}>
      <Text color={colors.textFaint}>{cwd}</Text>
      <Text color={colors.textFaint}>{version}</Text>
    </Box>
  );
}
