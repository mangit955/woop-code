import type { Tool } from "../config/types";

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
