import { Box, Text } from "ink";
import type { Token, Tokens } from "marked";
import { CodeBlock } from "./CodeBlock";
import { MermaidDiagram } from "./MermaidDiagram";
import { InlineCode } from "./InlineCode";
import type { ReactNode } from "react";
import { usePalette, useMarkdownPalette } from "../styles/palette";
import type { MarkdownPalette } from "../styles/theme";


interface MarkdownProps {
  tokens: Token[];
}

export function Markdown({ tokens }: MarkdownProps) {
  return (
    <Box flexDirection="column">
      {tokens.map((token, i) => (
        <MarkdownBlock key={i} token={token} />
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Block-level rendering
// ---------------------------------------------------------------------------

function MarkdownBlock({ token }: { token: Token }): ReactNode {
  const colors = usePalette();
  const md = useMarkdownPalette();

  switch (token.type) {
    case "heading": {
      const t = token as Tokens.Heading;
      const prefix = "#".repeat(t.depth) + " ";
      // OpenCode theme: accent purple for headings
      const color = md.heading;
      return (
        <Box marginTop={t.depth === 1 ? 2 : 1} marginBottom={1}>
          <Text bold color={color}>
            {prefix}
            {renderInline(t.tokens, md)}
          </Text>
        </Box>
      );
    }

    case "paragraph": {
      const t = token as Tokens.Paragraph;
      return (
        <Box marginBottom={1}>
          <Text color={md.text}>{renderInline(t.tokens, md)}</Text>
        </Box>
      );
    }

    case "code": {
      const t = token as Tokens.Code;
      if (t.lang?.toLowerCase() === "mermaid" || t.lang?.toLowerCase() === "mmd") {
        return <MermaidDiagram code={t.text} />;
      }
      return <CodeBlock code={t.text} language={t.lang || undefined} />;
    }

    case "blockquote": {
      const t = token as Tokens.Blockquote;
      return (
        <Box
          marginBottom={1}
          borderStyle="bold"
          borderLeft={true}
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderColor={md.blockQuote}
          paddingLeft={1}
        >
          <Box flexDirection="column">
            {t.tokens.map((inner, i) => (
              <MarkdownBlock key={i} token={inner} />
            ))}
          </Box>
        </Box>
      );
    }

    case "list": {
      const t = token as Tokens.List;
      return (
        <Box flexDirection="column" marginBottom={1}>
          {t.items.map((item, i) => {
            const prefix = t.ordered
              ? `${(typeof t.start === "number" ? t.start : 1) + i}. `
              : "• ";
            return <ListItem key={i} item={item} prefix={prefix} />;
          })}
        </Box>
      );
    }

    case "table": {
      const t = token as Tokens.Table;
      const termWidth = (process.stdout.columns || 80) - 4;

      // Extract visible plain text from a cell's inline tokens (for string-based layouts)
      const cellPlain = (tokens: Token[]): string =>
        tokens
          .map((tk) => {
            if ("tokens" in tk && Array.isArray(tk.tokens)) return cellPlain(tk.tokens as Token[]);
            if ("text" in tk) return (tk as { text: string }).text;
            return tk.raw ?? "";
          })
          .join("");

      const colWidths = t.header.map((h, ci) => {
        const hLen = cellPlain(h.tokens).length;
        const maxCell = t.rows.reduce(
          (max, row) => Math.max(max, cellPlain(row[ci]?.tokens ?? []).length),
          0,
        );
        return Math.max(hLen, maxCell, 3);
      });

      const pad = (str: string, width: number) =>
        str + " ".repeat(Math.max(0, width - str.length));

      const totalWidth = colWidths.reduce((sum, w) => sum + w + 3, 0) + 1;

      if (totalWidth <= termWidth) {
        // ── Horizontal table — string-based, plain text in cells ───────────
        const top = "╭" + colWidths.map((w) => "─".repeat(w + 2)).join("┬") + "╮";
        const mid = "├" + colWidths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
        const bot = "╰" + colWidths.map((w) => "─".repeat(w + 2)).join("┴") + "╯";
        const headerRow =
          "│" +
          t.header.map((h, i) => ` ${pad(cellPlain(h.tokens), colWidths[i]!)} `).join("│") +
          "│";
        const dataRows = t.rows.map(
          (row) =>
            "│" +
            row.map((cell, i) => ` ${pad(cellPlain(cell.tokens), colWidths[i]!)} `).join("│") +
            "│",
        );
        return (
          <Box marginBottom={1}>
            <Text color={md.hr}>{[top, headerRow, mid, ...dataRows, bot].join("\n")}</Text>
          </Box>
        );
      } else {
        // ── Vertical fallback — use renderInline so formatting renders ─────
        const labelWidth = Math.max(...t.header.map((h) => cellPlain(h.tokens).length));
        const divider = "─".repeat(Math.min(termWidth, 40));
        return (
          <Box flexDirection="column" marginBottom={1}>
            <Text color={colors.borderMuted}>{divider}</Text>
            {t.rows.map((row, ri) => (
              <Box key={ri} flexDirection="column">
                <Box flexDirection="column" marginY={1}>
                  {t.header.map((h, ci) => (
                    <Box key={ci}>
                      <Text color={colors.textMuted}>{`  ${pad(cellPlain(h.tokens), labelWidth)}  `}</Text>
                      <Text color={md.text}>{renderInline(row[ci]?.tokens ?? [], md)}</Text>
                    </Box>
                  ))}
                </Box>
                <Text color={colors.borderMuted}>{divider}</Text>
              </Box>
            ))}
          </Box>
        );
      }
    }



    case "hr": {
      const hrWidth = Math.min((process.stdout.columns || 80) - 6, 60);
      return (
        <Box marginY={1}>
          <Text color={md.hr}>{"─".repeat(hrWidth)}</Text>
        </Box>
      );
    }

    case "space":
      return null;

    default:
      // Unknown block types — show raw text if non-empty
      if (token.raw?.trim()) {
        return <Text color={md.text}>{token.raw}</Text>;
      }
      return null;
  }
}

// ---------------------------------------------------------------------------
// List items
// ---------------------------------------------------------------------------

function ListItem({
  item,
  prefix,
}: {
  item: Tokens.ListItem;
  prefix: string;
}) {
  const md = useMarkdownPalette();

  return (
    <Box>
      <Text color={md.listItem}>{prefix}</Text>
      <Box flexDirection="column" flexShrink={1}>
        {item.tokens.map((inner, j) => {
          // In tight lists, unwrap paragraphs to avoid extra spacing
          if (inner.type === "paragraph") {
            const p = inner as Tokens.Paragraph;
            return <Text key={j} color={md.text}>{renderInline(p.tokens, md)}</Text>;
          }
          // Tight list items use a bare "text" token instead of paragraph
          if (inner.type === "text") {
            const txt = inner as Tokens.Text;
            if (txt.tokens && txt.tokens.length > 0) {
              return <Text key={j} color={md.text}>{renderInline(txt.tokens, md)}</Text>;
            }
            return <Text key={j} color={md.text}>{txt.text}</Text>;
          }
          // Nested lists, code blocks, etc.
          return <MarkdownBlock key={j} token={inner} />;
        })}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

// Not a component, so it takes the palette rather than reading context.
function renderInline(tokens: Token[], md: MarkdownPalette): ReactNode[] {
  return tokens.map((token, i) => {
    switch (token.type) {
      case "text": {
        const t = token as Tokens.Text;
        if (t.tokens && t.tokens.length > 0) {
          return <Text key={i}>{renderInline(t.tokens, md)}</Text>;
        }
        return t.text;
      }

      case "strong": {
        const t = token as Tokens.Strong;
        return (
          <Text key={i} bold color={md.strong}>
            {renderInline(t.tokens, md)}
          </Text>
        );
      }

      case "em": {
        const t = token as Tokens.Em;
        return (
          <Text key={i} italic color={md.emph}>
            {renderInline(t.tokens, md)}
          </Text>
        );
      }

      case "codespan": {
        const t = token as Tokens.Codespan;
        return <InlineCode key={i} text={t.text} />;
      }

      case "link": {
        const t = token as Tokens.Link;
        // Render link text with accent color
        return (
          <Text key={i} color={md.linkText}>
            {renderInline(t.tokens, md)}
          </Text>
        );
      }

      case "br":
        return "\n";

      default:
        return token.raw;
    }
  });
}
