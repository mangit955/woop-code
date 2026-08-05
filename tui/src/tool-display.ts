/**
 * How a tool call reads in the transcript: `* Grep "signup" (8 matches)`.
 *
 * The glyph says what kind of work it was, the label names the tool, the
 * argument is the one detail worth showing, and the summary reports what came
 * back. Kept pure so each rule is checkable without rendering.
 */

/** Searching and listing — many results. */
const SEARCH_TOOLS = ["glob", "grep", "find_files", "list_files", "web_search"];
/** Fetching one thing. */
const READ_TOOLS = ["read_file", "web_fetch"];
const WRITE_TOOLS = ["write_file", "edit_file", "create_file", "delete_file"];
const RUN_TOOLS = ["run_terminal", "run_tests", "run_command", "execute_command"];

const LABELS: Record<string, string> = {
  glob: "Glob",
  grep: "Grep",
  find_files: "Find",
  list_files: "List",
  list_directory: "List",
  read_file: "Read",
  web_fetch: "Fetch",
  web_search: "Search",
  write_file: "Write",
  edit_file: "Edit",
  create_file: "Create",
  delete_file: "Delete",
  run_terminal: "Run",
  run_tests: "Test",
  run_command: "Run",
  execute_command: "Run",
  ask_user: "Ask",
};

/** Tools shown as a shell block — the command and its output — not a one-liner. */
export function isCommandTool(name: string) {
  return RUN_TOOLS.includes(name);
}

/**
 * Tools whose call row is suppressed because they render themselves.
 *
 * `todo_write` writes the checklist into the timeline, which appears directly
 * below its own call row — the same event twice, once as `• todo write` and once
 * as the list it just wrote. The list is the better of the two.
 */
const SELF_RENDERING_TOOLS = ["todo_write"];

export function rendersItself(name: string) {
  return SELF_RENDERING_TOOLS.includes(name);
}

/**
 * The mark in a settled tool call's rail.
 *
 * One mark for every kind, deliberately. This returned five — `*` for a search,
 * `→` for a read, `±` for a write, `$` for a run, `•` for anything else — which
 * put ASCII punctuation, an arrow and a maths operator in the same column of the
 * same list, alongside the `⊘`, `✗`, `▪` and `⊙` used elsewhere. Nine families
 * of mark on one screen reads as clutter, not as information.
 *
 * Nothing is lost: the row already names the tool beside the glyph, and "Read"
 * says what `→` was meant to. Marks are kept for the three things a glyph is
 * genuinely better at than a word — running, blocked, failed — where the state
 * is not otherwise written anywhere on the row. `ToolStatus` owns those.
 *
 * Still a function of the name so this stays the one place the rule lives, and
 * so a tool that earns a mark of its own has somewhere to declare it.
 */
export function toolGlyph(_name: string) {
  return "·";
}

export function toolLabel(name: string) {
  return LABELS[name] ?? name.replace(/_/g, " ");
}

export interface ToolArgument {
  text: string;
  /** Patterns read as patterns when quoted; paths and commands do not. */
  quoted: boolean;
}

/**
 * The single most identifying argument. Patterns win over paths, because a grep
 * carries both and the pattern is what the reader is following.
 */
export function formatToolArgument(
  arguments_: Record<string, unknown>,
): ToolArgument | null {
  for (const key of ["pattern", "query", "search"]) {
    const value = arguments_[key];
    if (typeof value === "string" && value !== "") return { text: value, quoted: true };
  }

  for (const key of ["path", "file", "filePath", "command", "url"]) {
    const value = arguments_[key];
    if (typeof value === "string" && value !== "") return { text: value, quoted: false };
  }

  const [first] = Object.values(arguments_);
  if (first === undefined || first === null || first === "") return null;

  return typeof first === "string"
    ? { text: first, quoted: true }
    : { text: JSON.stringify(first), quoted: false };
}

/** Tools whose output is a list worth counting. */
const COUNTED_TOOLS = new Set(SEARCH_TOOLS);
const EMPTY_RESULT = /^no (matches|files|matching)/i;

/**
 * A short report of what a tool returned, or undefined when a count would say
 * nothing useful — reading one file has no count worth printing.
 *
 * Counts the first paragraph only: these tools append notes about truncation
 * after a blank line, and those lines are not results.
 */
export function summarizeToolOutput(name: string, output: string) {
  if (!COUNTED_TOOLS.has(name)) return undefined;

  const [listing = ""] = output.split(/\n\s*\n/);
  if (EMPTY_RESULT.test(listing.trim())) return "no matches";

  const count = listing.split("\n").filter((line) => line.trim() !== "").length;
  if (count === 0) return undefined;

  const noun =
    name === "list_files" || name === "find_files"
      ? count === 1
        ? "file"
        : "files"
      : count === 1
        ? "match"
        : "matches";

  return `${count} ${noun}`;
}
