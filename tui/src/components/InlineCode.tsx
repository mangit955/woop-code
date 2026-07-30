import { Text } from "ink";
import { useDimmed } from "../styles/palette";
import { dimHex } from "../styles/theme";

interface InlineCodeProps {
  text: string;
}

const CODE_COLOR = "#7fd88f";
const CODE_BACKGROUND = "#1e1e1e";

export function InlineCode({ text }: InlineCodeProps) {
  // Its own colours rather than the theme's, so they need fading explicitly.
  const dimmed = useDimmed();

  return (
    <Text
      color={dimmed ? dimHex(CODE_COLOR) : CODE_COLOR}
      backgroundColor={dimmed ? dimHex(CODE_BACKGROUND) : CODE_BACKGROUND}
    >
      {` ${text} `}
    </Text>
  );
}
