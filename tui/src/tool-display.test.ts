import { describe, expect, test } from "bun:test";
import {
  formatToolArgument,
  summarizeToolOutput,
  toolGlyph,
  toolLabel,
} from "./tool-display";

describe("tool glyphs", () => {
  test("groups tools by the kind of work they do", () => {
    expect(toolGlyph("glob")).toBe("*");
    expect(toolGlyph("grep")).toBe("*");
    expect(toolGlyph("list_files")).toBe("*");
    expect(toolGlyph("read_file")).toBe("→");
    expect(toolGlyph("web_fetch")).toBe("→");
    expect(toolGlyph("edit_file")).toBe("±");
    expect(toolGlyph("run_tests")).toBe("$");
    expect(toolGlyph("ask_user")).toBe("?");
  });

  test("falls back rather than rendering nothing for an unknown tool", () => {
    expect(toolGlyph("some_new_tool")).toBe("•");
  });
});

describe("tool labels", () => {
  test("names the tool the way the model called it", () => {
    // "Grep" rather than "Search": the label should match the tool, so a reader
    // can tie the row back to what ran.
    expect(toolLabel("grep")).toBe("Grep");
    expect(toolLabel("glob")).toBe("Glob");
    expect(toolLabel("read_file")).toBe("Read");
    expect(toolLabel("run_tests")).toBe("Test");
  });

  test("makes an unknown tool readable instead of dropping it", () => {
    expect(toolLabel("some_new_tool")).toBe("some new tool");
  });
});

describe("tool arguments", () => {
  test("prefers the pattern over the path, and quotes it", () => {
    // A grep carries both; the pattern is what the reader is following.
    expect(formatToolArgument({ pattern: "signup", path: "tools" })).toEqual({
      text: "signup",
      quoted: true,
    });
    expect(formatToolArgument({ query: "websocket" })).toEqual({
      text: "websocket",
      quoted: true,
    });
  });

  test("leaves paths and commands unquoted", () => {
    expect(formatToolArgument({ path: "__tests__/auth-login.test.ts" })).toEqual({
      text: "__tests__/auth-login.test.ts",
      quoted: false,
    });
    expect(formatToolArgument({ command: "bun test" })).toEqual({
      text: "bun test",
      quoted: false,
    });
  });

  test("falls back to the first argument it can show", () => {
    expect(formatToolArgument({ questions: ["Which database?"] })).toEqual({
      text: '["Which database?"]',
      quoted: false,
    });
  });

  test("shows nothing rather than an empty quote", () => {
    expect(formatToolArgument({})).toBeNull();
    expect(formatToolArgument({ path: "" })).toBeNull();
    expect(formatToolArgument({ path: undefined })).toBeNull();
  });
});

describe("tool result summaries", () => {
  test("counts what a search returned", () => {
    expect(summarizeToolOutput("grep", "a.ts:1:hit\nb.ts:2:hit")).toBe("2 matches");
    expect(summarizeToolOutput("glob", "only.ts")).toBe("1 match");
  });

  test("counts files for the listing tools", () => {
    expect(summarizeToolOutput("list_files", "a.ts\nb.ts\nc.ts")).toBe("3 files");
    expect(summarizeToolOutput("find_files", "a.ts")).toBe("1 file");
  });

  test("ignores the notes these tools append after a blank line", () => {
    // Truncation notes are not results and must not inflate the count.
    const output = "a.ts\nb.ts\n\n(Results are truncated: showing first 100 results.)";
    expect(summarizeToolOutput("glob", output)).toBe("2 matches");
  });

  test("reports an empty result plainly", () => {
    expect(summarizeToolOutput("grep", "No matches found.")).toBe("no matches");
    expect(summarizeToolOutput("list_files", "No files found.")).toBe("no matches");
    expect(summarizeToolOutput("find_files", 'No matching files found for "x".')).toBe(
      "no matches",
    );
  });

  test("says nothing where a count would be meaningless", () => {
    // Reading one file has no count worth printing.
    expect(summarizeToolOutput("read_file", "file contents\nmore")).toBeUndefined();
    expect(summarizeToolOutput("edit_file", "ok")).toBeUndefined();
    expect(summarizeToolOutput("run_tests", "42 pass")).toBeUndefined();
    expect(summarizeToolOutput("glob", "")).toBeUndefined();
  });
});
