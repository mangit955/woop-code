import { Text } from "ink";
import { colors } from "../styles/theme";

interface InlineCodeProps {
  text: string;
}

export function InlineCode({ text }: InlineCodeProps) {
  return (
    <Text color={colors.textCode} backgroundColor={colors.bgLayer02}>
      {` ${text} `}
    </Text>
  );
}
