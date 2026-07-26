import { Box, Text } from "ink";
import type { TimeLineItem } from "./types";
import { MessageRenderer } from "./components/MessageRenderer";
import { ToolStatus } from "./components/ToolStatus";
import { colors } from "./styles/theme";

interface TimelineProps {
  items: TimeLineItem[];
  isThinking: boolean;
}

export function Timeline({ items, isThinking }: TimelineProps) {
  return (
    <Box flexDirection="column" flexShrink={0}>
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
        <Box flexDirection="row" marginBottom={1} flexShrink={0}>
          {/* Left accent bar — OpenCode style */}
          <Box flexShrink={0} marginRight={1}>
            <Text color={colors.primary}>│</Text>
          </Box>
          <Box flexDirection="column">
            <Text color={colors.textBase}>{item.content}</Text>
          </Box>
        </Box>
      );

    case "assistant":
      return (
        <Box flexDirection="column" marginBottom={1} flexShrink={0}>
          <Box gap={1} marginBottom={0}>
            <Text bold color={colors.primary}>
              Woopcode
            </Text>
            {item.streaming && (
              <Text color={colors.textMuted}> · thinking</Text>
            )}
          </Box>
          <Box paddingLeft={2}>
            <MessageRenderer content={item.content} streaming={item.streaming} />
          </Box>
        </Box>
      );

    case "system":
      return (
        <Box marginBottom={1} paddingLeft={2} flexShrink={0}>
          <Box gap={1}>
            <Text color={colors.textMuted}>⊙</Text>
            <Text color={colors.textMuted}>{item.content}</Text>
          </Box>
        </Box>
      );

    case "tool": {
      const label = toolLabel(item.name);
      const target = formatToolArgument(item.arguments);

      return (
        <Box flexDirection="column" marginBottom={0} paddingLeft={2} flexShrink={0}>
          <Box gap={1}>
            <ToolStatus status={item.status} />
            <Text bold color={colors.textMuted}>
              {label}
            </Text>
            {target && <Text color={colors.textFaint}>{target}</Text>}
          </Box>
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
    read_file: "Read",
    write_file: "Write",
    edit_file: "Edit",
    create_file: "Create",
    delete_file: "Delete",
    run_command: "Run",
    execute_command: "Run",
    search: "Search",
    grep: "Search",
    list_directory: "List",
    list_files: "List",
  };
  return map[name] ?? name.replace(/_/g, " ");
}
