import { Box, Text } from "ink";
import type { TimeLineItem } from "./types";
import { MessageRenderer } from "./components/MessageRenderer";

interface TimelineProps {
  items: TimeLineItem[];
}

export function Timeline({ items }: TimelineProps) {
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <TimelineItem key={item.id} item={item} />
      ))}
    </Box>
  );
}

function TimelineItem({ item }: { item: TimeLineItem }) {
  switch (item.type) {
    case "user":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold dimColor>
            You
          </Text>
          <Text>{item.content}</Text>
        </Box>
      );

    case "assistant":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text bold color="cyan">
              Woopcode
            </Text>
            {item.streaming && <Text dimColor> · thinking</Text>}
          </Box>
          <Box paddingLeft={1}>
            <MessageRenderer content={item.content} streaming={item.streaming} />
          </Box>
        </Box>
      );

    case "tool":
      const argument = formatToolArgument(item.arguments);

      return (
        <Box marginBottom={1} paddingLeft={1}>
          <Text dimColor>tool </Text>
          <Text>{item.name}</Text>
          {argument && <Text dimColor> · {argument}</Text>}
          <Text dimColor> · </Text>
          <Text
            color={item.status === "running" ? "cyan" : undefined}
            dimColor={item.status === "completed"}
          >
            {item.status}
          </Text>
        </Box>
      );
  }
}

function formatToolArgument(arguments_: Record<string, unknown>) {
  const value =
    arguments_.path ??
    arguments_.query ??
    arguments_.pattern ??
    Object.values(arguments_)[0];

  if (value === undefined) {
    return null;
  }

  return typeof value === "string" ? value : JSON.stringify(value);
}
