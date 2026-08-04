import { Box, Text } from "ink";
import type { TodoItem, TodoStatus } from "../../../config/types";
import { usePalette } from "../styles/palette";

interface TodoListProps {
  items: TodoItem[];
}

const GLYPHS: Record<TodoStatus, string> = {
  pending: "☐",
  in_progress: "◐",
  completed: "☑",
};

/**
 * The agent's task list, as a checklist.
 *
 * A count in the header rather than in each row: the useful question is how much
 * is left, and asking the reader to tally nine lines to answer it is worse than
 * saying it once.
 */
export function TodoList({ items }: TodoListProps) {
  const colors = usePalette();

  if (items.length === 0) return null;

  const done = items.filter((item) => item.status === "completed").length;

  return (
    <Box flexDirection="row" marginBottom={1} flexShrink={0}>
      <Box flexShrink={0} marginRight={1}>
        <Text color={colors.textFaint}>│</Text>
      </Box>
      <Box flexDirection="column" flexShrink={1} minWidth={0}>
        <Text color={colors.textFaint}>
          Tasks {done}/{items.length}
        </Text>
        {items.map((item, index) => (
          <Box key={`${index}-${item.content}`} flexDirection="row" flexShrink={1} minWidth={0}>
            <Box flexShrink={0} marginRight={1}>
              <Text color={colorFor(item.status, colors)}>{GLYPHS[item.status]}</Text>
            </Box>
            <Box flexShrink={1} minWidth={0}>
              {/* Completed steps are struck through and dimmed, so the eye lands
                  on what is left rather than on what is done. */}
              <Text
                color={colorFor(item.status, colors)}
                strikethrough={item.status === "completed"}
                bold={item.status === "in_progress"}
                wrap="truncate-end"
              >
                {item.content}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function colorFor(status: TodoStatus, colors: ReturnType<typeof usePalette>) {
  if (status === "completed") return colors.textFaint;
  if (status === "in_progress") return colors.primary;
  return colors.textBase;
}
