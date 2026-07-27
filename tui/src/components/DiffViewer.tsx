import { Box, Text } from "ink";
import { colors } from "../styles/theme";

interface DiffViewerProps {
  diff: string;
}

type ContextRow = {
  type: "context";
  content: string;
  oldLine: number;
  newLine: number;
};

type ChangeRow = {
  type: "addition" | "deletion";
  content: string;
  oldLine?: number;
  newLine?: number;
};

type DiffRow =
  | { type: "hunk"; content: string }
  | { type: "omitted"; count: number }
  | { type: "note"; content: string }
  | ContextRow
  | ChangeRow;

export function DiffViewer({ diff }: DiffViewerProps) {
  const rows = compactDiffRows(parseUnifiedDiff(diff));
  const lineNumberWidth = String(
    Math.max(
      1,
      ...rows.flatMap((row) =>
        "oldLine" in row ? [row.oldLine ?? 0, row.newLine ?? 0] : [],
      ),
    ),
  ).length;

  return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        <DiffLine key={`${row.type}-${index}`} row={row} numberWidth={lineNumberWidth} />
      ))}
    </Box>
  );
}

function DiffLine({ row, numberWidth }: { row: DiffRow; numberWidth: number }) {
  if (row.type === "hunk") {
    return (
      <Box paddingLeft={1} backgroundColor={colors.bgLayer02}>
        <Text color={colors.secondary}>{row.content}</Text>
      </Box>
    );
  }

  if (row.type === "omitted") {
    return (
      <Box paddingLeft={1}>
        <Text color={colors.textFaint}>  {" ".repeat(numberWidth * 2 + 3)}⋮ {row.count} unchanged lines</Text>
      </Box>
    );
  }

  if (row.type === "note") {
    return (
      <Box paddingLeft={1}>
        <Text color={colors.textFaint}>  {row.content}</Text>
      </Box>
    );
  }

  const isAddition = row.type === "addition";
  const isDeletion = row.type === "deletion";
  const marker = isAddition ? "+" : isDeletion ? "−" : " ";
  const lineColor = isAddition
    ? colors.diffAddHighlight
    : isDeletion
      ? colors.diffRemoveHighlight
      : colors.textMuted;
  const backgroundColor = isAddition
    ? colors.diffAddBg
    : isDeletion
      ? colors.diffRemoveBg
      : undefined;

  return (
    <Box paddingLeft={1} backgroundColor={backgroundColor}>
      <Text color={colors.textFaint} dimColor>
        {formatLineNumber(row.oldLine, numberWidth)} {formatLineNumber(row.newLine, numberWidth)}
      </Text>
      <Text color={lineColor}> {marker} </Text>
      <Box flexGrow={1} minWidth={0}>
        <Text color={isAddition || isDeletion ? colors.textBase : colors.textMuted} wrap="hard">
          {row.content || " "}
        </Text>
      </Box>
    </Box>
  );
}

export function parseUnifiedDiff(diff: string): DiffRow[] {
  let oldLine = 0;
  let newLine = 0;
  const rows: DiffRow[] = [];

  for (const line of diff.split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;

    if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      rows.push({ type: "hunk", content: line });
      continue;
    }

    if (line.startsWith("+")) {
      rows.push({ type: "addition", content: line.slice(1), newLine });
      newLine += 1;
      continue;
    }

    if (line.startsWith("-")) {
      rows.push({ type: "deletion", content: line.slice(1), oldLine });
      oldLine += 1;
      continue;
    }

    if (line.startsWith("\\")) {
      rows.push({ type: "note", content: line });
      continue;
    }

    if (line.startsWith(" ")) {
      rows.push({ type: "context", content: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return rows;
}

export function compactDiffRows(rows: DiffRow[]): DiffRow[] {
  const result: DiffRow[] = [];
  let context: ContextRow[] = [];

  const flushContext = () => {
    if (context.length <= 6) {
      result.push(...context);
    } else {
      result.push(...context.slice(0, 3));
      result.push({ type: "omitted", count: context.length - 6 });
      result.push(...context.slice(-3));
    }
    context = [];
  };

  for (const row of rows) {
    if (row.type === "context") {
      context.push(row);
      continue;
    }

    flushContext();
    result.push(row);
  }

  flushContext();
  return result;
}

function formatLineNumber(line: number | undefined, width: number) {
  return line === undefined ? " ".repeat(width) : String(line).padStart(width, " ");
}
