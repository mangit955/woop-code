import type { Tool } from "../config/types";

export const runTestsTool: Tool = {
  name: "run_tests",
  description: "Runs the project's test command.",
  parameters: [
    { name: "command", required: false, description: "defaults to bun test" },
  ],
  async execute(args) {
    const command =
      args.command && typeof args.command === "string"
        ? args.command
        : "bun test";

    const proc = Bun.spawn({
      cmd: ["sh", "-c", command],
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout.text(),
      proc.stderr.text(),
      proc.exited,
    ]);

    return `Exit code: ${exitCode}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;
  },
};
