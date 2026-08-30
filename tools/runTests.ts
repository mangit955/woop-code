import type { Tool } from "../config/types";
import { formatCommandResult } from "./command";
import { currentExecutor } from "../runtime/sandbox";
import { requestCommandApproval } from "./approval";
import { budgetedTimeout, wallBudgetTimeoutNotice } from "./timeoutBudget";

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
    
    const requestedSeconds = (args.timeout as number) || 60;

    // Classification and policy decide whether this needs a human; the tool
    // itself knows nothing about which commands are safe.
    const { approved } = await requestCommandApproval(command, "run_tests");
    if (!approved) {
      return "Command rejected by user. It was not run.";
    }

    // A server never exits, so it would hold the tool open until the timeout
    // rather than failing. Refused here instead, with the reason.
    if (command.includes("run src/index") || command.includes("run index") || command.includes("start")) {
      return "Error: This command appears to start a server. Use run_tests only for test suites, not for starting servers. Servers run indefinitely and will cause timeouts.";
    }

    // Read after approval rather than at the top: the clock runs while a human
    // decides, so a number taken earlier would grant the run time that was spent
    // waiting for permission to start it.
    const { seconds: timeoutSeconds, clamped } = budgetedTimeout(requestedSeconds);

    try {
      return formatCommandResult(
        await currentExecutor().run(command, timeoutSeconds, signal),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Command cancelled") {
        return "Tests cancelled before completion.";
      }
      if (error instanceof Error && error.message.includes("timed out")) {
        // The standing note guesses at a server, which is the wrong diagnosis
        // when the wall budget is what ended a suite that was running fine.
        if (clamped) {
          return `Error: ${error.message}\n\n${wallBudgetTimeoutNotice(requestedSeconds, timeoutSeconds)}`;
        }
        return `Error: ${error.message}\n\nNote: If you're trying to verify a server starts, don't. Just create the code and let the user test it manually.`;
      }
      throw error;
    }
  },
};
