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
  activeTurn: ActiveTurn | null;
}

/**
 * Timeline items laid out per frame.
 *
 * Ink re-lays out every mounted node on every commit, so an unbounded
 * transcript makes streaming progressively slower: measured, 200 streamed
 * tokens took 364ms at 50 items, 526ms at 500, and 2018ms at 2000 — about ten
 * milliseconds of layout per token by then. Capping bounds that cost whatever
 * the session length. The price is that rows past the cap leave in-app
 * scrollback; the conversation itself is untouched, and the count says so.
 */
const MAX_RENDERED_ITEMS = 300;

export function Timeline({ items, activeTurn }: TimelineProps) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <TimelineHistory items={items} />
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

/**
 * The settled transcript, memoized on the items array.
 *
 * The array identity only changes when the store emits, so a clock tick
 * re-renders the running turn's footer and the spinners inside it and leaves
 * every finished row alone.
 */
const TimelineHistory = memo(function TimelineHistory({
  items,
}: {
  items: TimeLineItem[];
}) {
  const colors = usePalette();
  const hidden = Math.max(0, items.length - MAX_RENDERED_ITEMS);
  const rendered = hidden === 0 ? items : items.slice(hidden);

  return (
    <>
      {hidden > 0 && (
        <Box marginBottom={1} paddingLeft={2} flexShrink={0}>
          <Text color={colors.textFaint}>
            {`… ${hidden} earlier item${hidden === 1 ? "" : "s"}`}
          </Text>
        </Box>
      )}
      {rendered.map((item) => (
        <TimelineItem key={item.id} item={item} />
      ))}
    </>
  );
});

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
