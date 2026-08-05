import { Text } from "ink";
import { usePalette } from "../styles/palette";

interface InlineCodeProps {
  text: string;
}

export function InlineCode({ text }: InlineCodeProps) {
  // Read through the palette rather than from two module constants of its own,
  // which is what removes the manual dimHex this used to need: behind a dialog
  // the span now fades with everything around it.
  const colors = usePalette();

  return (
    <Text color={colors.accent} backgroundColor={colors.bgCode}>
      {` ${text} `}
    </Text>
  );
}
