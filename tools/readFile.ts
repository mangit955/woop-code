import type { Tool } from "../config/types";
import { statSync } from "fs";
import { resolveWorkspacePath } from "./workspace";

/** Characters returned before the result is cut short. */
const MAX_OUTPUT = 16 * 1024;

/**
 * Reads a line range, 1-indexed and inclusive at both ends.
 *
 * Inclusive because that is how every tool the agent already reads from counts:
 * grep, compiler errors and stack traces all name a line, and an agent asking
 * for "lines 40 to 60" after seeing an error at 51 should get line 60.
 */
function sliceLines(
  content: string,
  startLine: number | undefined,
  endLine: number | undefined,
): { text: string; from: number; to: number; total: number } {
  const lines = content.split("\n");
  // A trailing newline produces a final empty element that is not a line.
  const total = lines.length > 0 && lines.at(-1) === "" ? lines.length - 1 : lines.length;

  const from = Math.max(1, startLine ?? 1);
  const to = Math.min(total, endLine ?? total);

  return { text: lines.slice(from - 1, to).join("\n"), from, to, total };
}

function positiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;

  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    throw Error(`${name} must be a whole number of 1 or more, got ${String(value)}`);
  }
  return parsed;
}

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Reads the contents of a file. Pass startLine and endLine to read only part " +
    "of a large file; both are 1-indexed and inclusive. Reading a range is " +
    "preferable to reading a whole large file when the relevant location is " +
    "already known, for example from a grep match or an error message.",
  parameters: [
    {
      name: "path",
      description: "Path to the file",
      required: true,
    },
    {
      name: "startLine",
      description:
        "First line to read, 1-indexed and inclusive. Defaults to the start of the file.",
      required: false,
      type: "number",
    },
    {
      name: "endLine",
      description:
        "Last line to read, 1-indexed and inclusive. Defaults to the end of the file.",
      required: false,
      type: "number",
    },
  ],

  async execute(args) {
    const requestedPath = args.path as string;

    if (!requestedPath) {
      throw Error("File path is required");
    }

    const startLine = positiveInteger(args.startLine, "startLine");
    const endLine = positiveInteger(args.endLine, "endLine");

    if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
      throw Error(`endLine (${endLine}) must not be before startLine (${startLine})`);
    }

    let path: string;
    try {
      path = await resolveWorkspacePath(requestedPath, { mustExist: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw Error(`File ${requestedPath} does not exist`);
      }
      throw error;
    }

    const file = Bun.file(path);

    if (!(await file.exists())) {
      throw Error(`File ${path} does not exist`);
    }

    // Check if path is a directory
    try {
      const stats = statSync(path);
      if (stats.isDirectory()) {
        throw Error(`Cannot read ${path}: it is a directory. Use list_files to see directory contents.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('is a directory')) {
        throw err;
      }
      // If stat fails for other reasons, continue trying to read
    }

    const content = await file.text();
    const ranged = startLine !== undefined || endLine !== undefined;

    if (!ranged) {
      // Returned verbatim so that edit_file's oldText can be copied straight
      // out of it, which the system prompt requires. A header here would end up
      // inside a replacement.
      if (content.length <= MAX_OUTPUT) return content;

      const { total } = sliceLines(content, undefined, undefined);
      return (
        content.slice(0, MAX_OUTPUT) +
        `\n\n... File truncated: showing the first ${MAX_OUTPUT} of ${content.length} characters ` +
        `(${total} lines total). Read a specific range with startLine and endLine to see the rest.`
      );
    }

    const { text, from, to, total } = sliceLines(content, startLine, endLine);

    if (from > total) {
      throw Error(
        `startLine ${from} is past the end of ${requestedPath}, which has ${total} lines`,
      );
    }

    // The header states what was returned so the agent knows where it is in the
    // file, and is separated from the content by a blank line so it reads as
    // metadata rather than as part of the file.
    const header = `Lines ${from}-${to} of ${total} in ${requestedPath}:`;

    if (text.length > MAX_OUTPUT) {
      return (
        `${header}\n\n${text.slice(0, MAX_OUTPUT)}` +
        `\n\n... Range truncated at ${MAX_OUTPUT} characters. Request fewer lines.`
      );
    }

    return `${header}\n\n${text}`;
  },
};
