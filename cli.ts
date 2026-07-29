#!/usr/bin/env bun
import { program } from "commander";
import { modelsCommand } from "./commands/models";
import { agentCommand, runAgent } from "./commands/agent";
import { providerCommand } from "./commands/providers";

program
  .name("woopcode")
  .description("Coding agent cli")
  .version("0.1.0")
  .option("-p, --prompt <prompt>", "run a single prompt headlessly and exit", "")
  .option("--no-auto-approve", "with --prompt, reject tool edits and commands instead of approving them")
  .action(runAgent)
  .addCommand(modelsCommand)
  .addCommand(agentCommand)
  .addCommand(providerCommand);

program.parse();
