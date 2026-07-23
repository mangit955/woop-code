import { Text } from "ink";

interface InlineCodeProps {
  text: string;
}

export function InlineCode({ text }: InlineCodeProps) {
  return (
    <Text color="#d4d4d4" backgroundColor="#2d2d2d">
      {` ${text} `}
    </Text>
  );
}
