import { Box, Text } from "ink";
import { highlight, supportsLanguage } from "cli-highlight";
import { useMemo } from "react";
import { usePalette, useDimmed } from "../styles/palette";
import { syntaxTheme } from "../styles/syntax";

interface DiffViewerProps {
  diff: string;
  /** Picks the syntax highlighter; a unified diff carries no language itself. */
  filePath?: string;
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

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  scss: "scss",
  html: "xml",
  xml: "xml",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  sql: "sql",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
};

/** The highlighter language for a path, or undefined to render it plain. */
export function languageFromPath(filePath?: string) {
  const extension = filePath?.split("/").pop()?.split(".").slice(1).pop()?.toLowerCase();
  const language = extension ? LANGUAGE_BY_EXTENSION[extension] : undefined;

  return language && supportsLanguage(language) ? language : undefined;
}

/**
 * Highlights one line, or returns null to leave it plain.
 *
 * Per line rather than per file because that is all a diff gives us: the
 * surrounding lines may not even be present. A line that opens a template
 * literal or block comment can therefore highlight oddly, which is the price of
 * colouring a fragment.
 */
export function highlightLine(content: string, language?: string) {
  if (!language || content.trim() === "") return null;

  try {
    return highlight(content, { language, ignoreIllegals: true, theme: syntaxTheme });
  } catch {
    return null;
  }
}

/** The number shown in the gutter: one column, from the side that has a line. */
function gutterNumber(row: DiffRow) {
  if (row.type === "addition") return row.newLine;
  if (row.type === "deletion") return row.oldLine;
  if (row.type === "context") return row.newLine;
  return undefined;
}

export function DiffViewer({ diff, filePath }: DiffViewerProps) {
  const rows = useMemo(() => compactDiffRows(parseUnifiedDiff(diff)), [diff]);
  const language = useMemo(() => languageFromPath(filePath), [filePath]);
  // A dimmed layer cannot use the highlighter: its colours are literal ANSI and
  // would stay at full strength behind a dialog.
  const dimmed = useDimmed();

  const highlighted = useMemo(
    () =>
      rows.map((row) =>
        dimmed || !("content" in row) ? null : highlightLine(row.content, language),
      ),
    [rows, language, dimmed],
  );

  const numberWidth = Math.max(
    1,
    ...rows.map((row) => String(gutterNumber(row) ?? "").length),
  );

  return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        <DiffLine
          key={`${row.type}-${index}`}
          row={row}
          numberWidth={numberWidth}
          highlighted={highlighted[index] ?? null}
        />
      ))}
    </Box>
  );
}

function DiffLine({
  row,
  numberWidth,
  highlighted,
}: {
  row: DiffRow;
  numberWidth: number;
  highlighted: string | null;
}) {
  const colors = usePalette();

  if (row.type === "hunk") {
    // The @@ header is noise next to a line-numbered gutter, so it reads as a
    // quiet separator rather than a line of code.
    return (
      <Box paddingX={1} flexShrink={0}>
        <Text color={colors.textFaint}>{"·".repeat(3)}</Text>
      </Box>
    );
  }

  if (row.type === "omitted") {
    return (
      <Box paddingX={1} flexShrink={0}>
        <Text color={colors.textFaint}>
          {" ".repeat(numberWidth)}   ⋮ {row.count} unchanged lines
        </Text>
      </Box>
    );
  }

  if (row.type === "note") {
    return (
      <Box paddingX={1} flexShrink={0}>
        <Text color={colors.textFaint}>
          {" ".repeat(numberWidth)}   {row.content}
        </Text>
      </Box>
    );
  }

  const isAddition = row.type === "addition";
  const isDeletion = row.type === "deletion";
  const marker = isAddition ? "+" : isDeletion ? "-" : " ";
  const background = isAddition
    ? colors.diffAddBg
    : isDeletion
      ? colors.diffRemoveBg
      : undefined;
  const markerColor = isAddition
    ? colors.diffAdd
    : isDeletion
      ? colors.diffRemove
      : colors.textFaint;

  return (
    // The tint runs the full width of the panel, so a changed line reads as a
    // band rather than as coloured text.
    <Box backgroundColor={background} paddingX={1} flexShrink={0}>
      <Box width={numberWidth} flexShrink={0} justifyContent="flex-end">
        <Text color={colors.textFaint}>{gutterNumber(row) ?? ""}</Text>
      </Box>
      <Text color={markerColor}>{` ${marker} `}</Text>
      <Box flexGrow={1} minWidth={0}>
        {highlighted ? (
          <Text wrap="truncate-end">{highlighted}</Text>
        ) : (
          <Text color={isAddition || isDeletion ? colors.textBase : colors.textMuted} wrap="truncate-end">
            {row.content || " "}
          </Text>
        )}
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
