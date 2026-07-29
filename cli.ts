#!/usr/bin/env bun
import { program } from "commander";
import { modelsCommand } from "./commands/models";
import { agentCommand, runAgent } from "./commands/agent";
import { providerCommand } from "./commands/providers";
import { VERSION } from "./config/version";

program
  .name("woopcode")
  .description("Coding agent cli")
  .version(VERSION)
  // Several subcommands declare their own `-p` (`providers login/logout
  // --provider`). Without positional options commander binds those to the
  // root's `-p, --prompt` and the subcommand silently sees an empty value.
  .enablePositionalOptions()
  .option("-p, --prompt <prompt>", "run a single prompt headlessly and exit", "")
  .option("--no-auto-approve", "with --prompt, reject tool edits and commands instead of approving them")
  .action(runAgent)
  .addCommand(modelsCommand)
  .addCommand(agentCommand)
  .addCommand(providerCommand);

program.parse();
