import { describe, expect, test } from "bun:test";
import { compactDiffRows, parseUnifiedDiff } from "./DiffViewer";

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
