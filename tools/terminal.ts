import type { Tool } from "../config/types";

export const terminalTool: Tool = {
  name: "run_terminal",
  description: "Runs a terminal command in the current project. For quick commands only (tests, builds, installs). Do not use for starting servers or long-running processes.",
  parameters: [
    {
      name: "command",
      description: "Command to execute",
      required: true,
    },
    {
      name: "timeout",
      description: "Timeout in seconds (default: 30). Command will be killed if it exceeds this time.",
      required: false,
    },
  ],

  async execute(args) {
    const command = args.command as string;
    const timeoutSeconds = (args.timeout as number) || 30;

    if (!command) {
      throw Error("command is required");
    }
    
    // Warn about potentially problematic commands (only single & for background, not &&)
    if (/\s&\s*$/.test(command) || /\s&\s+[^&]/.test(command)) {
      return "Error: Background processes (&) are not supported. Use run_terminal for quick commands only (tests, builds, installs), not for starting servers.";
    }

    const proc = Bun.spawn({
      cmd: ["sh", "-c", command],
      stdout: "pipe",
      stderr: "pipe",
    });

    // Set a timeout to prevent hanging forever
    const timeoutMs = timeoutSeconds * 1000;
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        proc.kill();
        reject(new Error(`Command timed out after ${timeoutSeconds} seconds`));
      }, timeoutMs);
    });

    try {
      // Race between command completion and timeout
      await Promise.race([proc.exited, timeoutPromise]);
      
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      if (stderr && !stdout) {
        return stderr;
      }
      
      return stdout || stderr || "";
    } catch (error) {
      if (error instanceof Error && error.message.includes("timed out")) {
        return `Error: ${error.message}\n\nNote: For long-running processes like servers, the agent cannot verify them. Just create/edit the code and inform the user to test manually.`;
      }
      throw error;
    }
  },
};
