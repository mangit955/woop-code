import type { Tool } from "../config/types";
import { store } from "../tui/src/store/ui-store";
import { formatCommandResult, runCommand } from "./command";

export const runTestsTool: Tool = {
  name: "run_tests",
  description: "Runs the project's test command. For quick test execution only - do not use to start servers.",
  parameters: [
    { name: "command", required: false, description: "defaults to bun test" },
    { name: "timeout", required: false, description: "timeout in seconds (default: 60)", type: "number" },
  ],
  async execute(args, signal) {
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

    try {
      return formatCommandResult(await runCommand(command, timeoutSeconds, signal));
    } catch (error) {
      if (error instanceof Error && error.message === "Command cancelled") {
        return "Tests cancelled before completion.";
      }
      if (error instanceof Error && error.message.includes("timed out")) {
        return `Error: ${error.message}\n\nNote: If you're trying to verify a server starts, don't. Just create the code and let the user test it manually.`;
      }
      throw error;
    }
  },
};
