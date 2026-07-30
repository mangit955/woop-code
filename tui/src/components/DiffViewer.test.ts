import { describe, expect, test } from "bun:test";
import {
  compactDiffRows,
  highlightLine,
  languageFromPath,
  parseUnifiedDiff,
} from "./DiffViewer";

const ANSI = new RegExp("\\u001B\\[[0-9;]*m", "g");

describe("unified diff rendering", () => {
  test("keeps accurate old and new line numbers", () => {
    const rows = parseUnifiedDiff("--- a/example.ts\n+++ b/example.ts\n@@ -4,3 +4,4 @@\n keep\n-old\n+new\n+added\n tail");

    expect(rows).toEqual([
      { type: "hunk", content: "@@ -4,3 +4,4 @@" },
      { type: "context", content: "keep", oldLine: 4, newLine: 4 },
      { type: "deletion", content: "old", oldLine: 5 },
      { type: "addition", content: "new", newLine: 5 },
      { type: "addition", content: "added", newLine: 6 },
      { type: "context", content: "tail", oldLine: 6, newLine: 7 },
    ]);
  });

  test("collapses long unchanged sections without hiding nearby context", () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      type: "context" as const,
      content: `line ${index + 1}`,
      oldLine: index + 1,
      newLine: index + 1,
    }));

    expect(compactDiffRows(rows)).toEqual([
      ...rows.slice(0, 3),
      { type: "omitted", count: 2 },
      ...rows.slice(-3),
    ]);
  });
});

describe("diff syntax language", () => {
  test("maps a file extension to a highlighter language", () => {
    expect(languageFromPath("components/loggedin_Navbar.tsx")).toBe("typescript");
    expect(languageFromPath("cli.ts")).toBe("typescript");
    expect(languageFromPath("src/main.py")).toBe("python");
  });

  test("reads the extension, not the first dot in the path", () => {
    expect(languageFromPath("~/.config/woopcode/config.json")).toBe("json");
    expect(languageFromPath("a.b.c/file.test.ts")).toBe("typescript");
  });

  test("is case insensitive", () => {
    expect(languageFromPath("README.MD")).toBe("markdown");
  });

  test("returns nothing to highlight with when it cannot tell", () => {
    expect(languageFromPath(undefined)).toBeUndefined();
    expect(languageFromPath("Makefile")).toBeUndefined();
    expect(languageFromPath("archive.zzz")).toBeUndefined();
  });
});

describe("diff line highlighting", () => {
  test("keeps the code intact", () => {
    const line = "const supabase = createSupabaseClient();";
    const highlighted = highlightLine(line, "typescript");

    expect(highlighted).not.toBeNull();
    // Colour codes are only emitted when the terminal supports them, but the
    // code itself has to survive either way.
    expect(highlighted!.replace(ANSI, "")).toBe(line);
  });

  test("leaves a line plain when there is nothing to highlight with", () => {
    expect(highlightLine("const x = 1;", undefined)).toBeNull();
    expect(highlightLine("   ", "typescript")).toBeNull();
    expect(highlightLine("", "typescript")).toBeNull();
  });

  test("survives content the highlighter cannot parse", () => {
    // A diff hands over fragments, so unbalanced syntax is normal input.
    expect(() => highlightLine("}}} unbalanced ${", "typescript")).not.toThrow();
  });
});
