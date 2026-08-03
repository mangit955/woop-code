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

/**
 * How long a command runs before it is killed, when the caller names no limit.
 *
 * Thirty seconds was the original figure, and a benchmark run shows what it
 * killed:
 *
 *   apt-get update && apt-get install -y build-essential wget ...
 *   cd /app/source && make -f unix.mak -j$(nproc)
 *
 * A dependency install and the build the task was set to perform, both cut off
 * mid-way and reported to the agent as an error. The model has no reason to
 * know it must pass a `timeout` argument to compile something, so the default
 * has to fit the work rather than the fastest example of it.
 *
 * Five minutes, not longer: a command still running then is usually the thing
 * this tool refuses anyway — a server, a watch process — and an agent waiting
 * on one has stopped making progress.
 */
const DEFAULT_TIMEOUT_SECONDS = 300;

export const terminalTool: Tool = {
  name: "run_terminal",
  description: "Runs a terminal command in the current project. For commands that finish on their own (tests, builds, installs). Do not use for starting servers or long-running processes.",
  parameters: [
    {
      name: "command",
      description: "Command to execute",
      required: true,
    },
    {
      name: "timeout",
      description: `Timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS}). Command will be killed if it exceeds this time. Raise it for a build or test run expected to take longer.`,
      required: false,
      type: "number",
    },
  ],

  async execute(args, signal) {
    const command = args.command as string;
    const timeoutSeconds = (args.timeout as number) || DEFAULT_TIMEOUT_SECONDS;

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
