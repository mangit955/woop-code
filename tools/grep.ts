import type { Tool } from "../config/types";

export const grepTool: Tool = {
  name: "grep",
  description: "Searches recursively for text in project files.",
  parameters: [
    { name: "pattern", required: true, description: "text to search for" },
    {
      name: "path",
      required: false,
      description: "directory to search, default process.cwd()",
    },
  ],
  async execute(args) {
    const pattern = args.pattern;
    if (!pattern || typeof pattern !== "string") {
      throw new Error("Parameter 'pattern' is required and must be a string.");
    }
    const path =
      args.path && typeof args.path === "string" ? args.path : process.cwd();

    const proc = Bun.spawn({
      cmd: ["grep", "-RIn", pattern, path],
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout.text(),
      proc.stderr.text(),
      proc.exited,
    ]);

    if (exitCode === 1) {
      return "No matches found.";
    }
    if (exitCode > 1) {
      throw new Error(stderr);
    }
    return stdout;
  },
};
