import type { Tool } from "../config/types";
import { statSync } from "fs";

export const readFileTool: Tool = {
  name: "read_file",
  description: "Reads the contents of a file.",
  parameters: [
    {
      name: "path",
      description: "Path to the file",
      required: true,
    },
  ],

  async execute(args) {
    const path = args.path as string;

    if (!path) {
      throw Error("File path is required");
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

    const MAX_OUTPUT = 16 * 1024; // 16 KB
    const content = await file.text();

    if (content.length > MAX_OUTPUT) {
      return (
        content.slice(0, MAX_OUTPUT) +
        `\n\n... File truncated. Showing first ${MAX_OUTPUT} characters of ${content.length}.`
      );
    }

    return content;
  },
};
