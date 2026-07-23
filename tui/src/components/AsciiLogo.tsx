import { Box, Text } from "ink";
import { useLogoAnimation } from "../hooks/useLogoAnimation";

const REVEAL_DURATION_MS = 500;
const WORD_SPACING = "    ";

export interface AsciiLogoProps {
  word: string;
  revealDuration?: number;
}

export function AsciiLogo({
  word,
  revealDuration = REVEAL_DURATION_MS,
}: AsciiLogoProps) {
  const logoLines = createLogoLines(word);
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
            <Text bold color="cyan">{visibleWoop}</Text>
            <Text bold dimColor>{visibleCode}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function createLogoLines(word: string): Array<{ woop: string; code: string }> {
  if (word.toUpperCase() !== "WOOPCODE") {
    throw new Error("AsciiLogo currently supports the WOOPCODE wordmark only.");
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
