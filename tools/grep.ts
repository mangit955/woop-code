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
      cmd: [
        "grep",
        "-RIn",
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "--exclude-dir=dist",
        "--exclude-dir=build",
        "--exclude-dir=.next",
        "--exclude-dir=coverage",
        "--exclude=bun.lock",
        "--exclude=package-lock.json",
        "--exclude=pnpm-lock.yaml",
        "--exclude=yarn.lock",
        pattern,
        path,
      ],
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
    const MAX_OUTPUT_SIZE = 8 * 1024;

    if (stdout.length <= MAX_OUTPUT_SIZE) {
      return stdout;
    }

    return (
      stdout.slice(0, MAX_OUTPUT_SIZE) +
      `\n\n... Output truncated (${stdout.length - MAX_OUTPUT_SIZE} more bytes). ` +
      `Refine your search or use read_file on a specific file.`
    );
  },
};
