import type { Tool } from "../config/types";

export const listFilesTool: Tool = {
  name: "list_Files",
  description: "List all the files in the directory",
  parameters: [
    {
      name: "path",
      description: "Directory path",
      required: false,
    },
  ],

  async execute(args) {
    const path = (args.path as string) || process.cwd();

    const files: string[] = [];

    for await (const file of new Bun.Glob("**/*").scan(path)) {
      if (
        file.startsWith("node_modeules") ||
        file.startsWith("dist") ||
        file.startsWith("git")
      ) {
        continue;
      }

      files.push(file);
    }

    return files.join("\n");
  },
};
