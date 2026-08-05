#!/usr/bin/env bun
import { program } from "commander";
import { modelsCommand } from "./commands/models";
import { addSessionOptions, agentCommand, runAgent } from "./commands/agent";
import { providerCommand } from "./commands/providers";
import { sessionsCommand } from "./commands/sessions";
import { VERSION } from "./config/version";

addSessionOptions(program)
  .name("woopcode")
  .description("Coding agent cli")
  .version(VERSION)
  // Several subcommands declare their own `-p` (`providers login/logout
  // --provider`). Without positional options commander binds those to the
  // root's `-p, --prompt` and the subcommand silently sees an empty value.
  .enablePositionalOptions()
  .option("-p, --prompt <prompt>", "run a single prompt headlessly and exit", "")
  .option("--no-auto-approve", "with --prompt, reject tool edits and commands instead of approving them")
  .option("-m, --model <model>", "model id to use for this run")
  .option("--events <path>", "with --prompt, write a JSONL record of the run to this path")
  .action(runAgent)
  .addCommand(modelsCommand)
  .addCommand(agentCommand)
  .addCommand(providerCommand)
  .addCommand(sessionsCommand);

// A configuration failure (no provider, unusable key) is a normal outcome for
// an automated caller, not a crash. Reporting it as a one-line message with a
// non-zero exit keeps a harness's logs readable and its exit-code check
// meaningful, where an unhandled rejection would dump a stack trace instead.
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`✖ ${message}\n`);
  process.exit(1);
});

program.parse();
