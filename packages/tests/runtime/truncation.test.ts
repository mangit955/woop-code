import { describe, test, expect } from "bun:test";
import { MAX_TOOL_RESULT, truncateToolResult } from "../../../runtime/loop";

describe("tool result truncation", () => {
  test("output within the budget is untouched", () => {
    expect(truncateToolResult("short output")).toBe("short output");
  });

  test("output exactly at the budget is untouched", () => {
    const exact = "x".repeat(MAX_TOOL_RESULT);
    expect(truncateToolResult(exact)).toBe(exact);
  });

  /**
   * The reason this exists. A test run puts its summary last, a build puts its
   * errors last, and a stack trace puts the root cause last — head-only
   * truncation showed the agent that a command ran and hid that it failed.
   */
  test("the end of a failing test run survives", () => {
    const output = [
      "bun test v1.3.13",
      ...Array.from({ length: 500 }, (_, i) => `pass  test case number ${i}`),
      "",
      "  2 fail",
      "  498 pass",
      "error: parser.ts:88 expected 3 tokens, received 2",
    ].join("\n");

    const truncated = truncateToolResult(output);

    expect(truncated).toContain("2 fail");
    expect(truncated).toContain("parser.ts:88 expected 3 tokens");
  });

  test("the start survives too, because read_file has no range parameter", () => {
    const file = [
      "import { readFile } from 'fs';",
      ...Array.from({ length: 500 }, (_, i) => `const line${i} = ${i};`),
      "export default line499;",
    ].join("\n");

    const truncated = truncateToolResult(file);

    expect(truncated).toContain("import { readFile } from 'fs';");
    expect(truncated).toContain("export default line499;");
  });

  test("says how much was dropped rather than implying the output ended", () => {
    const truncated = truncateToolResult("a\n".repeat(5000));

    expect(truncated).toMatch(/\d+ characters omitted from the middle/);
    expect(truncated).toMatch(/\d+ lines/);
  });

  test("stays within a predictable bound", () => {
    const truncated = truncateToolResult("x\n".repeat(50_000));

    // The marker adds a fixed overhead on top of the two halves.
    expect(truncated.length).toBeLessThan(MAX_TOOL_RESULT + 200);
  });

  test("cuts on line boundaries so neither end resumes mid-token", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line-${i}-content`);
    const truncated = truncateToolResult(lines.join("\n"));

    const [head, tail] = truncated.split(/\n\n…[^…]+…\n\n/);
    expect(head!.endsWith("-content")).toBe(true);
    expect(tail!.startsWith("line-")).toBe(true);
  });

  test("a single enormous line still fits the budget", () => {
    // Minified output or one long JSON blob has no line break to cut on;
    // falling back to the raw offset keeps the budget from collapsing.
    const blob = "y".repeat(40_000);
    const truncated = truncateToolResult(blob);

    expect(truncated.length).toBeLessThan(MAX_TOOL_RESULT + 200);
    expect(truncated).toContain("omitted from the middle");
  });

  test("honours a caller-supplied limit", () => {
    const truncated = truncateToolResult("z\n".repeat(500), 100);
    expect(truncated.length).toBeLessThan(300);
  });
});
