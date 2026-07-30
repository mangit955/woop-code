import { Box, Text } from "ink";
import { useLogoAnimation } from "../hooks/useLogoAnimation";
import { colors } from "../styles/theme";

const REVEAL_DURATION_MS = 500;
const WORD_SPACING = "    ";

export interface AsciiLogoProps {
  word: string;
  revealDuration?: number;
  /**
   * "compact" swaps the six-row figlet for a one-line wordmark. The figlet is
   * 73 columns wide and clips into unreadable fragments below that, so a
   * narrow terminal gets the small mark rather than half of the big one.
   */
  variant?: "full" | "compact";
}

export function AsciiLogo({
  word,
  revealDuration = REVEAL_DURATION_MS,
  variant = "full",
}: AsciiLogoProps) {
  const logoLines = createLogoLines(word, variant);
  const fullLogo = logoLines.map(({ woop, code }) => `${woop}${code}`).join("\n");
  const { progress } = useLogoAnimation({
    text: fullLogo,
    duration: revealDuration,
    mode: "typewriter",
  });
  let remainingCharacters = Math.floor(progress * fullLogo.length);

  return (
    <Box flexDirection="column">
      {logoLines.map(({ woop, code }, index) => {
        const visibleWoop = takeVisible(woop, remainingCharacters);
        remainingCharacters -= woop.length;
        const visibleCode = takeVisible(code, remainingCharacters);
        remainingCharacters -= code.length;
        if (index < logoLines.length - 1) remainingCharacters -= 1;

        return (
          <Box key={index}>
            <Text bold color={colors.primary}>{visibleWoop}</Text>
            <Text bold color={colors.textFaint}>{visibleCode}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function createLogoLines(
  word: string,
  variant: "full" | "compact",
): Array<{ woop: string; code: string }> {
  if (word.toUpperCase() !== "WOOPCODE") {
    throw new Error("AsciiLogo currently supports the WOOPCODE wordmark only.");
  }

  if (variant === "compact") {
    return [{ woop: "WOOP", code: "CODE" }];
  }

  return ANSI_SHADOW_WOOP.map((woop, index) => ({
    woop,
    code: `${WORD_SPACING}${ANSI_SHADOW_CODE[index] ?? ""}`,
  }));
}

function takeVisible(value: string, remainingCharacters: number) {
  return value.slice(0, Math.max(0, remainingCharacters));
}

// Generated with FIGlet's ANSI Shadow font, then kept as text so the TUI has
// no font runtime or package dependency.
const ANSI_SHADOW_WOOP = [
  "██╗    ██╗ ██████╗  ██████╗ ██████╗ ",
  "██║    ██║██╔═══██╗██╔═══██╗██╔══██╗",
  "██║ █╗ ██║██║   ██║██║   ██║██████╔╝",
  "██║███╗██║██║   ██║██║   ██║██╔═══╝ ",
  "╚███╔███╔╝╚██████╔╝╚██████╔╝██║     ",
  " ╚══╝╚══╝  ╚═════╝  ╚═════╝ ╚═╝     ",
] as const;

const ANSI_SHADOW_CODE = [
  " ██████╗ ██████╗ ██████╗ ███████╗",
  "██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  "██║     ██║   ██║██║  ██║█████╗  ",
  "██║     ██║   ██║██║  ██║██╔══╝  ",
  "╚██████╗╚██████╔╝██████╔╝███████╗",
  " ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
] as const;

/**
 * Columns the full wordmark needs. Exported so the layout thresholds can be
 * checked against the real figlet width instead of a copied constant.
 */
export const FULL_WORDMARK_COLUMNS =
  ANSI_SHADOW_WOOP[0].length + WORD_SPACING.length + ANSI_SHADOW_CODE[0].length;
