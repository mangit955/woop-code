import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { colors } from "../styles/theme";

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;

export function StatusSpinner() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
    }, 100);

    return () => clearInterval(interval);
  }, []);

  return (
    <Box width={1} flexShrink={0}>
      <Text color={colors.textStrong}>{SPINNER_FRAMES[frame]}</Text>
    </Box>
  );
}
