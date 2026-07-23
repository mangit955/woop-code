import { Box, Text } from "ink";
import { highlight } from "cli-highlight";
import chalk from "chalk";

interface CodeBlockProps {
  code: string;
  language?: string;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  let highlighted: string;
  try {
    highlighted = highlight(code.trimEnd(), {
      language: language || undefined,
      ignoreIllegals: true,
    });
  } catch {
    highlighted = code.trimEnd();
  }

  const lines = highlighted.split("\n");
  const dim = chalk.dim;

  const termWidth = Math.max((process.stdout.columns || 80) - 6, 30);
  const maxContent = lines.reduce(
    (max, l) => Math.max(max, stripAnsi(l).length),
    0,
  );
  // box = │(1) + left pad(2) + content + right pad(1) + │(1) = content + 5
  const boxWidth = Math.min(Math.max(maxContent + 6, 30), termWidth);
  const inner = boxWidth - 5;

  // ╭─ language ────────╮
  const label = language ? `─ ${language} ` : "─";
  const topFill = Math.max(0, boxWidth - label.length - 2);
  const top = dim(`╭${label}${"─".repeat(topFill)}╮`);

  // ╰────────────────────╯
  const bottom = dim(`╰${"─".repeat(boxWidth - 2)}╯`);

  // empty padding row
  const empty = dim("│") + " ".repeat(boxWidth - 2) + dim("│");

  // code rows — truncate long lines at inner width so the box never breaks
  const rows = lines.map((line) => {
    const vis = stripAnsi(line).length;
    if (vis > inner) {
      // Trim the raw string until its visible length fits, then add …
      // We strip ANSI from the trimmed portion and use the highlighted version
      // only when it fits — safest approach for ANSI-heavy strings.
      const truncated = stripAnsi(line).slice(0, inner - 1) + "…";
      const pad = inner - truncated.length;
      return dim("│") + "  " + truncated + " ".repeat(Math.max(0, pad)) + " " + dim("│");
    }
    const pad = inner - vis;
    return dim("│") + "  " + line + " ".repeat(pad) + " " + dim("│");
  });

  const output = [top, empty, ...rows, empty, bottom].join("\n");

  return (
    <Box marginY={1}>
      <Text>{output}</Text>
    </Box>
  );
}
