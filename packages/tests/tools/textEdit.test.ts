import { describe, expect, test } from "bun:test";
import {
  applyEdit,
  describeAmbiguity,
  findOccurrences,
  type EditOutcome,
} from "../../../tools/textEdit";

/** The content of an applied edit, or a failure that says which kind it was. */
function edited(outcome: EditOutcome): string {
  if (outcome.kind !== "applied") throw new Error(`expected an applied edit, got ${outcome.kind}`);
  return outcome.content;
}

describe("finding occurrences", () => {
  test("reports every match with its line and column", () => {
    const content = "const a = 1;\nconst b = 2;\nconst a = 3;\n";
    const found = findOccurrences(content, "const a");

    expect(found.map(({ line, column, index }) => ({ line, column, index }))).toEqual([
      { line: 1, column: 1, index: 0 },
      { line: 3, column: 1, index: 26 },
    ]);
  });

  test("columns are 1-based within the line", () => {
    const [occurrence] = findOccurrences("first\n  needle here", "needle");

    expect(occurrence).toMatchObject({ line: 2, column: 3 });
  });

  test("counts non-overlapping matches only", () => {
    // Replacing the first `aa` in `aaa` leaves `a`, so there is one occurrence
    // to speak of, not two.
    expect(findOccurrences("aaa", "aa")).toHaveLength(1);
    expect(findOccurrences("aaaa", "aa")).toHaveLength(2);
  });

  test("a multiline match spans from its first line to its last", () => {
    const [occurrence] = findOccurrences("one\ntwo\nthree\nfour", "two\nthree");

    expect(occurrence).toMatchObject({ line: 2, endLine: 3 });
  });

  test("an empty pattern matches nothing rather than everything", () => {
    expect(findOccurrences("abc", "")).toEqual([]);
  });

  test("the pattern is literal text, not a regular expression", () => {
    const content = "if (a.b[0] === $x) { return; }";

    expect(findOccurrences(content, "a.b[0]")).toHaveLength(1);
    expect(findOccurrences(content, "$x")).toHaveLength(1);
    // Would match everything if it were compiled as a pattern.
    expect(findOccurrences(content, ".*")).toHaveLength(0);
  });
});

describe("previewing an occurrence", () => {
  const content = [
    "line1",
    "line2",
    "line3",
    "line4",
    "target",
    "line6",
    "line7",
    "line8",
    "line9",
  ].join("\n");

  test("shows the match marked, with its neighbours", () => {
    const [occurrence] = findOccurrences(content, "target");

    expect(occurrence!.preview).toBe(
      [
        "  1 | line1",
        "  2 | line2",
        "  3 | line3",
        "  4 | line4",
        "> 5 | target",
        "  6 | line6",
        "  7 | line7",
        "  8 | line8",
        "  9 | line9",
      ].join("\n"),
    );
  });

  test("marks every line of a multiline match", () => {
    const [occurrence] = findOccurrences("a\nb\nc\nd", "b\nc");

    expect(occurrence!.preview).toBe(
      ["  1 | a", "> 2 | b", "> 3 | c", "  4 | d"].join("\n"),
    );
  });

  test("does not run past the start or end of the file", () => {
    const [occurrence] = findOccurrences("only line", "only");

    expect(occurrence!.preview).toBe("> 1 | only line");
  });
});

describe("applying an edit", () => {
  test("a unique match is replaced", () => {
    expect(edited(applyEdit("hello world", "world", "universe"))).toBe("hello universe");
  });

  test("no match is an error, not a silent no-op", () => {
    expect(applyEdit("hello", "missing", "x").kind).toBe("not-found");
  });

  test("an empty pattern is refused", () => {
    // It matches at every position, so it names no place in particular.
    expect(applyEdit("abc", "", "X").kind).toBe("empty-pattern");
  });

  test("several matches are ambiguous rather than the first one", () => {
    const outcome = applyEdit("foo\nfoo\nfoo\n", "foo", "bar");

    expect(outcome.kind).toBe("ambiguous");
    if (outcome.kind !== "ambiguous") return;
    expect(outcome.occurrences.map((occurrence) => occurrence.line)).toEqual([1, 2, 3]);
  });

  test("ambiguity is refused even when the edit would change nothing", () => {
    // No exception for the no-op case: the rule is about which occurrence the
    // caller meant, and that is unanswered here either way.
    expect(applyEdit("foo foo", "foo", "foo").kind).toBe("ambiguous");
  });

  test("replaceAll changes every non-overlapping occurrence", () => {
    const outcome = applyEdit("foo\nfoo\nfoo\n", "foo", "bar", { replaceAll: true });

    expect(edited(outcome)).toBe("bar\nbar\nbar\n");
    expect(outcome.kind === "applied" && outcome.replacements).toBe(3);
  });

  test("replaceAll on a unique match is still one replacement", () => {
    const outcome = applyEdit("foo bar", "foo", "baz", { replaceAll: true });

    expect(edited(outcome)).toBe("baz bar");
    expect(outcome.kind === "applied" && outcome.replacements).toBe(1);
  });

  test("replaceAll consumes each match, leaving overlaps alone", () => {
    expect(edited(applyEdit("aaa", "aa", "b", { replaceAll: true }))).toBe("ba");
  });
});

describe("replacement is literal", () => {
  // String.replace expands these in the replacement even for a string pattern,
  // which used to corrupt any edit inserting a literal `$`.
  test.each([
    // name, content, oldText, newText, expected
    ["$&", "hello", "hello", "[$&]", "[$&]"],
    ["$`", "ab", "b", "[$`]", "a[$`]"],
    ["$'", "ab", "a", "[$']", "[$']b"],
    ["$1", "ab", "a", "[$1]", "[$1]b"],
    ["$$", "ab", "a", "[$$]", "[$$]b"],
  ])("%s in newText is written as itself", (_name, content, oldText, newText, expected) => {
    expect(edited(applyEdit(content, oldText, newText))).toBe(expected);
  });

  test("regex metacharacters in oldText match themselves", () => {
    expect(edited(applyEdit("price: $100 (net)", "$100", "$200"))).toBe("price: $200 (net)");
    expect(edited(applyEdit("a.b.c", "a.b", "x"))).toBe("x.c");
    expect(edited(applyEdit("path\\to\\file", "\\to", "\\at"))).toBe("path\\at\\file");
  });
});

describe("the ambiguity message", () => {
  const content = [
    "function load() {",
    "  const result = fetchUser(id);",
    "  return result;",
    "}",
    "",
    "function reload() {",
    "  const result = fetchUser(id);",
    "  return result;",
    "}",
  ].join("\n");

  const message = () => {
    const outcome = applyEdit(content, "const result = fetchUser(id);", "x");
    if (outcome.kind !== "ambiguous") throw new Error("expected ambiguity");
    return describeAmbiguity(outcome.occurrences, "src/api.ts");
  };

  test("names the file, the count and every line", () => {
    expect(message()).toContain("Found 2 matches for oldText in src/api.ts (lines 2, 7).");
  });

  test("shows each match in context, so the file need not be read again", () => {
    expect(message()).toContain("> 2 |   const result = fetchUser(id);");
    expect(message()).toContain("> 7 |   const result = fetchUser(id);");
    expect(message()).toContain("  1 | function load() {");
    expect(message()).toContain("  6 | function reload() {");
  });

  test("reports the column of each match", () => {
    expect(message()).toContain("Line 2, column 3:");
    expect(message()).toContain("Line 7, column 3:");
  });

  test("offers more context before it offers replaceAll", () => {
    const text = message();

    expect(text).toContain("Extend oldText");
    expect(text).toContain("replaceAll: true");
    // Recovery order matters: replaceAll is for a deliberate rename, not for
    // getting unstuck.
    expect(text.indexOf("Extend oldText")).toBeLessThan(text.indexOf("replaceAll: true"));
  });

  test("caps the previews but still counts everything", () => {
    const many = Array.from({ length: 9 }, () => "needle").join("\n");
    const outcome = applyEdit(many, "needle", "x");
    if (outcome.kind !== "ambiguous") throw new Error("expected ambiguity");

    const text = describeAmbiguity(outcome.occurrences, "big.txt");
    expect(text).toContain("Found 9 matches");
    expect(text).toContain("… and 4 more at 6, 7, 8, 9.");
    expect(text).not.toContain("Line 6, column 1:");
  });
});
