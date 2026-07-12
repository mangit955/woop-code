import { Command } from "commander";
import { getConfig } from "../config/config";

export const agentCommand = new Command("agent")
  .description("Runs the agent")
  .option("-p, --prompt <prompt>", "prompt", "")
  .action(async (options) => {
    const config = await getConfig();

    console.log("User prompt is ..." + options.prompt);
  });
