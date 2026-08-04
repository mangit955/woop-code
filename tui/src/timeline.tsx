import { Box, Text } from "ink";
import { memo } from "react";
import type { ActiveTurn, TimeLineItem } from "./types";
import { MessageRenderer } from "./components/MessageRenderer";
import { ToolStatus } from "./components/ToolStatus";
import { TurnFooter } from "./components/TurnFooter";
import { usePalette } from "./styles/palette";
import {
  formatToolArgument,
  isCommandTool,
  rendersItself,
  toolGlyph,
  toolLabel,
} from "./tool-display";
import { CommandBlock } from "./components/CommandBlock";
import { TodoList } from "./components/TodoList";

interface TimelineProps {
  items: TimeLineItem[];
  isThinking: boolean;
  activeTurn: ActiveTurn | null;
}

export function Timeline({ items, isThinking, activeTurn }: TimelineProps) {
  const colors = usePalette();

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
  const colors = usePalette();

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

    case "todo":
      return <TodoList items={item.items} />;

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
      // The checklist this call produced is already in the timeline just below,
      // so the row would be the same event a second time.
      if (rendersItself(item.name)) return null;

      // Command tools carry output worth reading, so they render as a block
      // rather than as a one-line record.
      if (isCommandTool(item.name)) {
        return (
          <CommandBlock
            command={commandOf(item.arguments, item.name)}
            output={item.output}
            status={item.status}
          />
        );
      }

      const argument = formatToolArgument(item.arguments);

      // One quiet line: glyph, tool, the argument worth reading, and what came
      // back. The whole row stays muted — it is a record of work, not the work.
      return (
        <Box marginBottom={0} paddingLeft={2} flexShrink={0} gap={1}>
          <ToolStatus status={item.status} glyph={toolGlyph(item.name)} />
          <Text color={colors.textMuted}>{toolLabel(item.name)}</Text>
          {argument && (
            <Box flexShrink={1} minWidth={0}>
              <Text color={colors.textFaint} wrap="truncate-end">
                {argument.quoted ? `"${argument.text}"` : argument.text}
              </Text>
            </Box>
          )}
          {item.summary && (
            <Box flexShrink={0}>
              <Text color={colors.textFaint}>{`(${item.summary})`}</Text>
            </Box>
          )}
        </Box>
      );
    }
  }
});

/** run_tests defaults to `bun test` when the model does not name a command. */
function commandOf(arguments_: Record<string, unknown>, name: string) {
  const command = arguments_.command;
  if (typeof command === "string" && command.trim() !== "") return command;

  return name === "run_tests" ? "bun test" : name;
}
