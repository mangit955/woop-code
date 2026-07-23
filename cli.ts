#!/usr/bin/env bun
import { program } from "commander";
import { modelsCommand } from "./commands/models";
import { agentCommand, runAgent } from "./commands/agent";
import { providerCommand } from "./commands/providers";

program
  .name("woopcode")
  .description("Coding agent cli")
  .version("0.1.0")
  .option("-p, --prompt <prompt>", "prompt", "")
  .action(runAgent)
  .addCommand(modelsCommand)
  .addCommand(agentCommand)
  .addCommand(providerCommand);

program.parse();
