import type { Tool } from "../config/types";
import { store } from "../tui/src/store/ui-store";
import { formatCommandResult, runCommand } from "./command";
import { requestCommandApproval } from "./approval";

function startsBackgroundProcess(command: string) {
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    // `&&`, `>&2`, and `&>` are control/redirection syntax, not background
    // operators. Any other unquoted ampersand backgrounds a process.
    if (
      char === "&" &&
      command[index - 1] !== "&" &&
      command[index + 1] !== "&" &&
      command[index - 1] !== ">" &&
      command[index + 1] !== ">"
    ) return true;
  }
  return false;
}

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
      type: "number",
    },
  ],

  async execute(args, signal) {
    const command = args.command as string;
    const timeoutSeconds = (args.timeout as number) || 30;

    if (!command) {
      throw Error("command is required");
    }

    // Classification and policy decide whether this needs a human; the tool
    // itself knows nothing about which commands are safe.
    const { approved } = await requestCommandApproval(command, "run_terminal");
    if (!approved) {
      return "Command rejected by user. It was not run.";
    }
    
    if (startsBackgroundProcess(command)) {
      return "Error: Background processes (&) are not supported. Use run_terminal for quick commands only (tests, builds, installs), not for starting servers.";
    }

    try {
      return formatCommandResult(await runCommand(command, timeoutSeconds, signal));
    } catch (error) {
      if (error instanceof Error && error.message === "Command cancelled") {
        return "Command cancelled before completion.";
      }
      if (error instanceof Error && error.message.includes("timed out")) {
        return `Error: ${error.message}\n\nNote: For long-running processes like servers, the agent cannot verify them. Just create/edit the code and inform the user to test manually.`;
      }
      throw error;
    }
  },
};
