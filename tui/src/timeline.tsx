import { Box, Text } from "ink";
import { memo } from "react";
import type { ActiveTurn, TimeLineItem } from "./types";
import { MessageRenderer } from "./components/MessageRenderer";
import { ToolStatus } from "./components/ToolStatus";
import { TurnFooter } from "./components/TurnFooter";
import { colors } from "./styles/theme";

interface TimelineProps {
  items: TimeLineItem[];
  isThinking: boolean;
  activeTurn: ActiveTurn | null;
}

export function Timeline({ items, isThinking, activeTurn }: TimelineProps) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {items.map((item) => (
        <TimelineItem key={item.id} item={item} />
      ))}
      {/* Rendered after the items rather than as one of them: the running turn's
          footer has to stay below whatever the turn appends next, which is what
          walks it down the transcript toward the composer. */}
      {activeTurn && (
        <TurnFooter
          key={activeTurn.id}
          agent={activeTurn.agent}
          model={activeTurn.model}
          startedAt={activeTurn.startedAt}
          endedAt={null}
          outcome={null}
        />
      )}
    </Box>
  );
}

const TimelineItem = memo(function TimelineItem({ item }: { item: TimeLineItem }) {
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
            <MessageRenderer content={item.content} />
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

    case "turn":
      return (
        <TurnFooter
          agent={item.agent}
          model={item.model}
          startedAt={item.startedAt}
          endedAt={item.endedAt}
          outcome={item.outcome}
        />
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
});

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
