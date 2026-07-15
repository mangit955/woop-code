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
    return await file.text();
  },
};
