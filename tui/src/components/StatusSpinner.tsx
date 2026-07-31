import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { useDimmed } from "../styles/palette";
import { dimHex } from "../styles/theme";

const TRACK_LENGTH = 8;
const HOLD_AT_START = 30;
const HOLD_AT_END = 9;
const TOTAL_FRAMES =
  TRACK_LENGTH + HOLD_AT_END + (TRACK_LENGTH - 1) + HOLD_AT_START;

// A periwinkle ramp stepped around the theme's primary (#ACA3EC): the head sits
// on the accent itself, the bloom one step lighter, and the trail darkens
// through it.
const spinnerColors = {
  head: "#ACA3EC",
  bloom: "#C6C0F4",
  trailNear: "#8F83E0",
  trailMid: "#7263CE",
  trailFar: "#5A4CAB",
  trailLast: "#453B82",
} as const;

function getScannerFrame(frameIndex: number) {
  const frame = frameIndex % TOTAL_FRAMES;

  if (frame < TRACK_LENGTH) {
    return {
      head: frame,
      direction: 1,
      holdProgress: 0,
      holdTotal: 0,
      movementProgress: frame,
    };
  }

  if (frame < TRACK_LENGTH + HOLD_AT_END) {
    return {
      head: TRACK_LENGTH - 1,
      direction: 1,
      holdProgress: frame - TRACK_LENGTH,
      holdTotal: HOLD_AT_END,
      movementProgress: 0,
    };
  }

  if (frame < TRACK_LENGTH + HOLD_AT_END + TRACK_LENGTH - 1) {
    const movementProgress = frame - TRACK_LENGTH - HOLD_AT_END;
    return {
      head: TRACK_LENGTH - 2 - movementProgress,
      direction: -1,
      holdProgress: 0,
      holdTotal: 0,
      movementProgress,
    };
  }

  return {
    head: 0,
    direction: -1,
    holdProgress: frame - TRACK_LENGTH - HOLD_AT_END - (TRACK_LENGTH - 1),
    holdTotal: HOLD_AT_START,
    movementProgress: 0,
  };
}

function inactiveColor(
  movementProgress: number,
  holdProgress: number,
  holdTotal: number,
) {
  const progress =
    holdTotal > 0
      ? 1 - holdProgress / holdTotal
      : movementProgress / (TRACK_LENGTH - 1);
  const amount = Math.max(0, Math.min(1, progress));
  // Blend from the terminal background into the inactive periwinkle. True-color
  // interpolation avoids the hard brightness jumps that make a TUI spinner
  // look jittery at its turnaround points.
  const start: [number, number, number] = [10, 10, 10];
  const end: [number, number, number] = [44, 39, 82];
  const channel = (index: 0 | 1 | 2) =>
    Math.round(start[index] + (end[index] - start[index]) * amount)
      .toString(16)
      .padStart(2, "0");

  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

export function StatusSpinner() {
  const [frame, setFrame] = useState(0);
  // The spinner carries its own ramp, so it fades itself.
  const dimmed = useDimmed();
  const shade = (color: string) => (dimmed ? dimHex(color) : color);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((current) => (current + 1) % TOTAL_FRAMES);
    }, 60);

    return () => clearInterval(interval);
  }, []);

  return (
    <Box width={TRACK_LENGTH} flexShrink={0}>
      <Text>
        {Array.from({ length: TRACK_LENGTH }, (_, index) => {
          const scanner = getScannerFrame(frame);
          const directionalDistance =
            scanner.direction === 1
              ? scanner.head - index
              : index - scanner.head;
          const colorIndex =
            scanner.holdTotal > 0
              ? directionalDistance + scanner.holdProgress
              : directionalDistance;

          if (colorIndex === 0) {
            return (
              <Text key={index} color={shade(spinnerColors.head)}>
                ▪
              </Text>
            );
          }

          if (colorIndex === 1) {
            return (
              <Text key={index} color={shade(spinnerColors.bloom)}>
                ▪
              </Text>
            );
          }

          const trailColors = [
            spinnerColors.trailNear,
            spinnerColors.trailMid,
            spinnerColors.trailFar,
            spinnerColors.trailLast,
          ].map(shade);
          if (colorIndex >= 2 && colorIndex < trailColors.length + 2) {
            return (
              <Text key={index} color={trailColors[colorIndex - 2]}>
                ▪
              </Text>
            );
          }

          return (
            <Text
              key={index}
              color={shade(inactiveColor(
                scanner.movementProgress,
                scanner.holdProgress,
                scanner.holdTotal,
              ))}
            >
              ·
            </Text>
          );
        })}
      </Text>
    </Box>
  );
}
