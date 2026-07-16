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
      const ignoredDirs = [
        "node_modules",
        ".git",
        "dist",
        "build",
        ".next",
        "coverage",
      ];

      if (
        ignoredDirs.some((dir) => file === dir || file.startsWith(`${dir}/`))
      ) {
        continue;
      }

      files.push(file);
    }
    const MAX_TOOL_OUTPUT = 8 * 1024; // 8 KB
    const output = files.join("\n");

    if (output.length <= MAX_TOOL_OUTPUT) {
      return output;
    }

    return (
      output.slice(0, MAX_TOOL_OUTPUT) +
      `\n\n... Output truncated (${output.length - MAX_TOOL_OUTPUT} more characters)`
    );
  },
};
