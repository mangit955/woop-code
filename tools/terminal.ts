import type { Tool } from "../config/types";

export const terminalTool: Tool = {
  name: "run_terminal",
  description: "Runs a terminal command in the current project.",
  parameters: [
    {
      name: "command",
      description: "Command to execute",
      required: true,
    },
  ],

  async execute(args) {
    const command = args.command as string;

    if (!command) {
      throw Error("command is required");
    }

    const proc = Bun.spawn({
      cmd: ["sh", "-c", command],
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    await proc.exited;

    if (stderr) {
      return stderr;
    }
    return stdout;
  },
};
