import { useMemo } from "react";
import { Box } from "ink";
import { lexer, type Token } from "marked";
import { Markdown } from "./Markdown";
import { StreamingCursor } from "./StreamingCursor";

interface MessageRendererProps {
  content: string;
  streaming?: boolean;
}

/**
 * Closes any unclosed code fence so marked.lexer() doesn't break
 * while a message is still streaming.
 *
 * This is the only "healing" we do — marked handles incomplete
 * bold, italic, lists, etc. gracefully on its own.
 */
function healMarkdown(text: string): string {
  if (!text) return text;

  const lines = text.split("\n");
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inFence) {
      const match = trimmed.match(/^(`{3,}|~{3,})/);
      if (match) {
        inFence = true;
        fenceChar = match[1]![0]!;
        fenceLen = match[1]!.length;
      }
    } else {
      // Closing fence: same char, at least same length, nothing else on the line
      const closes = new RegExp(
        `^${fenceChar}{${fenceLen},}\\s*$`,
      ).test(trimmed);
      if (closes) {
        inFence = false;
      }
    }
  }

  // If we ended inside an open fence, close it
  if (inFence) {
    return text + "\n" + fenceChar.repeat(fenceLen);
  }

  return text;
}

export function MessageRenderer({ content, streaming }: MessageRendererProps) {
  const tokens = useMemo((): Token[] => {
    if (!content?.trim()) return [];

    try {
      const healed = healMarkdown(content);
      return lexer(healed);
    } catch {
      // If marked fails for any reason, fall back to plain text
      return [
        {
          type: "paragraph",
          raw: content,
          text: content,
          tokens: [{ type: "text", raw: content, text: content }],
        },
      ] as Token[];
    }
  }, [content]);

  if (tokens.length === 0) return null;

  return (
    <Box flexDirection="column">
      <Markdown tokens={tokens} />
      {streaming && <StreamingCursor />}
    </Box>
  );
}
