import type { Tool } from "../config/types";

export const writeFileTool: Tool = {
  name: "write_file",

  description: "Overwrite an existing file.",

  parameters: [
    {
      name: "path",
      description: "File path",
      required: true,
    },
    {
      name: "content",
      description: "New file contents",
      required: true,
    },
  ],

  async execute(args) {
    const path = args.path as string;
    const content = args.content as string;

    const file = Bun.file(path);

    if (!(await file.exists())) {
      throw new Error(`File not found: ${path}`);
    }

    await Bun.write(path, content);

    return `Updated ${path}`;
  },
};
