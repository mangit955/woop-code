import { describe, expect, test } from "bun:test";
import chalk from "chalk";
import { render } from "ink";
import { Writable } from "node:stream";
import { Timeline } from "./timeline";
import { TRANSCRIPT_GUTTER } from "./layout";
import type { TimeLineItem } from "./types";

/**
 * The transcript's left edge, row by row.
 *
 * Every row type indents itself the same amount, and nothing but a rendered
 * frame can check that. Reading the diff cannot: each row's indent is correct in
 * isolation and the defect is only the relationship between them. It went
 * unnoticed for exactly that reason — the transcript ran four conventions at
 * once, the user row at one column, the assistant's label at another with its
 * own prose at a third, tool rows at a fourth.
 */

chalk.level = 3;

const ESC = new RegExp("\\u001B\\[[0-9;?]*[A-Za-z]", "g");

class Capture extends Writable {
  isTTY = true;
  columns = 110;
  rows = 40;
  frames: string[] = [];
  override _write(chunk: unknown, _encoding: unknown, done: () => void) {
    this.frames.push(String(chunk));
    done();
  }
  /** The latest frame with content, split into lines with escapes stripped. */
  lines() {
    for (let index = this.frames.length - 1; index >= 0; index--) {
      const stripped = this.frames[index]!.replace(ESC, "");
      if (stripped.trim() !== "") {
        return stripped.replace(/\n$/, "").split("\n");
      }
    }
    return [];
  }
}

const STARTED = 1_700_000_000_000;

/** One of every row type the timeline can draw. */
const items: TimeLineItem[] = [
  { id: "1", type: "user", content: "Add retry to the provider client" },
  {
    id: "2",
    type: "assistant",
    content: "Reading the client first.",
    streaming: false,
  },
  {
    id: "3",
    type: "tool",
    name: "grep",
    arguments: { pattern: "withRetry" },
    status: "completed",
    summary: "8 matches",
  },
  {
    id: "4",
    type: "tool",
    name: "edit_file",
    arguments: { path: "runtime/retry.ts" },
    status: "failed",
  },
  {
    id: "5",
    type: "tool",
    name: "run_terminal",
    arguments: { command: "bun test" },
    status: "completed",
    output: "42 pass",
  },
  {
    id: "6",
    type: "todo",
    items: [{ content: "Add the retry", status: "completed" }],
  },
  { id: "7", type: "system", content: "Switched to gemini-3-pro" },
  {
    id: "8",
    type: "turn",
    agent: "Build",
    model: "gemini-3-pro",
    startedAt: STARTED,
    endedAt: STARTED + 4200,
    outcome: "completed",
  },
] as TimeLineItem[];

function renderTimeline() {
  const stdout = new Capture();
  const instance = render(<Timeline items={items} activeTurn={null} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  });
  const lines = stdout.lines();
  instance.unmount();
  return lines;
}

/** Columns before the first non-space character, or null for a blank row. */
function indentOf(line: string): number | null {
  if (line.trim() === "") return null;
  return line.length - line.trimStart().length;
}

describe("transcript grid", () => {
  test("renders something to measure", () => {
    // A frame that came back empty would satisfy every assertion below.
    const lines = renderTimeline();
    expect(lines.filter((line) => line.trim() !== "").length).toBeGreaterThan(6);
  });

  test("every row starts at the rail or at the gutter, and nowhere else", () => {
    // Two legal columns, not one. A row that opens a block puts its rail — │,
    // the state glyph, the turn marker — in column zero; a row continuing that
    // block starts at the gutter, under the content above it. Anything else is
    // a third convention, which is what this file exists to prevent.
    const indents = renderTimeline()
      .map(indentOf)
      .filter((indent): indent is number => indent !== null);

    expect(new Set(indents)).toEqual(new Set([0, TRANSCRIPT_GUTTER]));
  });

  test("content sits at the gutter on every kind of row", () => {
    const lines = renderTimeline().filter((line) => line.trim() !== "");

    // Each of these is a different row type, and the text after the rail has to
    // begin at the same column in all of them.
    const contentColumn = (needle: string) => {
      const line = lines.find((candidate) => candidate.includes(needle));
      expect(line, `no row containing ${needle}`).toBeDefined();
      return line!.indexOf(needle);
    };

    expect(contentColumn("Add retry to the provider client")).toBe(TRANSCRIPT_GUTTER);
    expect(contentColumn("Woopcode")).toBe(TRANSCRIPT_GUTTER);
    expect(contentColumn("Reading the client first.")).toBe(TRANSCRIPT_GUTTER);
    expect(contentColumn("Grep")).toBe(TRANSCRIPT_GUTTER);
    expect(contentColumn("Edit")).toBe(TRANSCRIPT_GUTTER);
    expect(contentColumn("$ bun test")).toBe(TRANSCRIPT_GUTTER);
    expect(contentColumn("Tasks")).toBe(TRANSCRIPT_GUTTER);
    expect(contentColumn("Switched to")).toBe(TRANSCRIPT_GUTTER);
    expect(contentColumn("Build")).toBe(TRANSCRIPT_GUTTER);
  });

  test("an assistant reply shares a left edge with its own speaker label", () => {
    // The row this test exists for: the label used to sit two columns outside
    // the prose it introduced.
    const lines = renderTimeline().filter((line) => line.trim() !== "");
    const label = lines.find((line) => line.includes("Woopcode"))!;
    const prose = lines.find((line) => line.includes("Reading the client"))!;

    expect(label.indexOf("Woopcode")).toBe(prose.indexOf("Reading the client"));
  });
});
