import { Text } from "ink";
import { colors } from "../styles/theme";

interface InlineCodeProps {
  text: string;
}

export function InlineCode({ text }: InlineCodeProps) {
  return (
    <Text color="#7fd88f" backgroundColor="#1e1e1e">
      {` ${text} `}
    </Text>
  );
}
