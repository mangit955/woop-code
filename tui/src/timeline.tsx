import { Box, Text } from "ink";
import type { TimeLineItem } from "./types";
import { MessageRenderer } from "./components/MessageRenderer";
import { ToolStatus } from "./components/ToolStatus";
import { ThinkingIndicator } from "./components/ThinkingIndicator";

interface TimelineProps {
  items: TimeLineItem[];
  isThinking: boolean;
}

export function Timeline({ items, isThinking }: TimelineProps) {
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <TimelineItem key={item.id} item={item} />
      ))}
      {isThinking && <ThinkingIndicator />}
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

    case "tool": {
      const label = toolLabel(item.name);
      const target = formatToolArgument(item.arguments);

      return (
        <Box flexDirection="column" marginBottom={1} paddingLeft={1}>
          <Box gap={1}>
            <Text bold color="#888888">{label}</Text>
            {target && <Text>{target}</Text>}
          </Box>
          <ToolStatus status={item.status} />
        </Box>
      );
    }
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

function toolLabel(name: string): string {
  const map: Record<string, string> = {
    read_file: "READ",
    write_file: "WRITE",
    edit_file: "EDIT",
    create_file: "CREATE",
    delete_file: "DELETE",
    run_command: "RUN",
    execute_command: "RUN",
    search: "SEARCH",
    grep: "SEARCH",
    list_directory: "LIST",
    list_files: "LIST",
  };
  return map[name] ?? name.toUpperCase().replace(/_/g, " ");
}
