import type { Tool } from "../config/types";
import { store } from "../tui/src/store/ui-store";

export const runTestsTool: Tool = {
  name: "run_tests",
  description: "Runs the project's test command. For quick test execution only - do not use to start servers.",
  parameters: [
    { name: "command", required: false, description: "defaults to bun test" },
    { name: "timeout", required: false, description: "timeout in seconds (default: 60)", type: "number" },
  ],
  async execute(args) {
    const command =
      args.command && typeof args.command === "string"
        ? args.command
        : "bun test";
    
    const timeoutSeconds = (args.timeout as number) || 60;

    const approved = await store.setPendingCommand({
      id: crypto.randomUUID(),
      command,
      toolName: "run_tests",
    });
    if (!approved) {
      return "Command rejected by user. It was not run.";
    }

    // Warn about server commands
    if (command.includes("run src/index") || command.includes("run index") || command.includes("start")) {
      return "Error: This command appears to start a server. Use run_tests only for test suites, not for starting servers. Servers run indefinitely and will cause timeouts.";
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
        reject(new Error(`Tests timed out after ${timeoutSeconds} seconds`));
      }, timeoutMs);
    });

    try {
      // Race between test completion and timeout
      await Promise.race([proc.exited, timeoutPromise]);
      
      const stdout = await proc.stdout.text();
      const stderr = await proc.stderr.text();
      const exitCode = proc.exitCode;

      return `Exit code: ${exitCode}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;
    } catch (error) {
      if (error instanceof Error && error.message.includes("timed out")) {
        return `Error: ${error.message}\n\nNote: If you're trying to verify a server starts, don't. Just create the code and let the user test it manually.`;
      }
      throw error;
    }
  },
};
