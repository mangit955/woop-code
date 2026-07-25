import { parseInput } from "./parser";
import { registry } from "./registry";
import type { SlashCommandContext } from "./types";

export async function handleSlashCommand(
  input: string,
  context: SlashCommandContext,
): Promise<{ handled: boolean; output?: string }> {
  const parsed = parseInput(input);

  // Discovery mode: show available commands
  if (parsed.type === "discovery") {
    const output = registry.generateDiscoveryList();
    context.onOutput(output);
    return { handled: true, output };
  }

  if (parsed.type !== "command") {
    return { handled: false };
  }

  const command = registry.get(parsed.command!);

  if (!command) {
    const output = `Unknown command "/${parsed.command}"\nRun /help to see available commands.`;
    context.onOutput(output);
    return { handled: true, output };
  }

  try {
    const output = await command.execute(context, parsed.args!);
    context.onOutput(output);
    return { handled: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const output = `Error: ${message}`;
    context.onOutput(output);
    return { handled: true, output };
  }
}
