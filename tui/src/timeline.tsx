import { Box, Text } from "ink";
import type { TimeLineItem } from "./types";

interface TimelineProps {
  items: TimeLineItem[];
}

export function Timeline({ items }: TimelineProps) {
  return (
    <Box flexDirection="column">
      {items.map((item) => {
        switch (item.type) {
          case "user":
            return (
              <Box key={item.id} flexDirection="column" marginBottom={1}>
                <Text bold color="cyan">
                  You
                </Text>
                <Text>{item.content}</Text>
              </Box>
            );

          case "assistant":
            return (
              <Box key={item.id} flexDirection="column" marginBottom={1}>
                <Text bold color="green">
                  AI
                </Text>
                <Text>{item.content}</Text>
              </Box>
            );

          case "tool":
            return (
              <Box key={item.id} marginBottom={1}>
                <Text color="yellow">
                  {item.label} ({item.status})
                </Text>
              </Box>
            );
        }
      })}
    </Box>
  );
}
