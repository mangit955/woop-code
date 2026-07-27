import { Box, Text } from "ink";
import { colors } from "../styles/theme";

interface MermaidDiagramProps {
  code: string;
}

interface DiagramLine {
  from: string;
  to: string;
  label?: string;
}

/** Render the common Mermaid diagram forms in a terminal-friendly format. */
export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const diagram = formatMermaid(code);

  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={colors.primary}
    >
      <Text bold color={colors.primary}>
        ◇ Mermaid · {diagram.kind}
      </Text>
      <Text color={colors.textBase}>{diagram.lines.join("\n")}</Text>
    </Box>
  );
}

export function formatMermaid(code: string): { kind: string; lines: string[] } {
  const source = code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("%%"));
  const declaration = source[0]?.toLowerCase() ?? "";

  if (declaration.startsWith("sequencediagram")) {
    return { kind: "sequence", lines: formatSequence(source.slice(1)) };
  }

  if (declaration.startsWith("graph") || declaration.startsWith("flowchart")) {
    return { kind: "flowchart", lines: formatFlowchart(source.slice(1)) };
  }

  return {
    kind: "diagram",
    lines: limitLines(source.map((line) => `  ${line}`)),
  };
}

function formatFlowchart(source: string[]): string[] {
  const edges = source
    .filter((line) => !/^(subgraph|end|direction)\b/i.test(line))
    .map(parseFlowEdge)
    .filter((edge): edge is DiagramLine => edge !== null);

  if (edges.length === 0) {
    return ["  No connections found"];
  }

  return limitLines(
    edges.map(({ from, to, label }) =>
      label ? `  ${from} ── ${label} ──▶ ${to}` : `  ${from} ─────────▶ ${to}`,
    ),
  );
}

function parseFlowEdge(line: string): DiagramLine | null {
  const match = line.match(/^(.+?)\s*(?:-->|==>|-\.->|---)\s*(?:\|([^|]+)\|\s*)?(.+)$/);
  if (!match) return null;

  const from = nodeLabel(match[1]!);
  const to = nodeLabel(match[3]!);
  if (!from || !to) return null;

  return { from, to, label: match[2]?.trim() };
}

function formatSequence(source: string[]): string[] {
  const messages = source
    .filter((line) => !/^(participant|actor|note)\b/i.test(line))
    .map((line) => {
      const match = line.match(/^(.+?)\s*(-{1,2}(?:>>|>)|--x)\s*(.+?)(?:\s*:\s*(.*))?$/);
      if (!match) return null;

      const from = nodeLabel(match[1]!);
      const to = nodeLabel(match[3]!);
      const message = match[4]?.trim();
      return message
        ? `  ${from} ──▶ ${to}: ${message}`
        : `  ${from} ──▶ ${to}`;
    })
    .filter((line): line is string => line !== null);

  return messages.length > 0 ? limitLines(messages) : ["  No messages found"];
}

function nodeLabel(value: string): string {
  const trimmed = value.trim();
  const shape = trimmed.match(/[\[{(]+(.+?)[\]})]+/);
  const label = shape?.[1] ?? trimmed.match(/[A-Za-z0-9_:-]+/)?.[0] ?? "";
  return label.replace(/["']/g, "").trim();
}

function limitLines(lines: string[]): string[] {
  const maximum = 24;
  return lines.length > maximum
    ? [...lines.slice(0, maximum), "  …"]
    : lines;
}
