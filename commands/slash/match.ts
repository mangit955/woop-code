import { registry } from "./registry";
import type { SlashCommand } from "./types";

/**
 * Commands to offer for what has been typed so far. Bare "/" offers everything.
 *
 * Shared rather than inlined in the composer because two places need the same
 * answer: the composer renders the list, and the home screen has to know the
 * list is open so it can give up the rows the list needs.
 */
export function matchCommands(input: string): SlashCommand[] {
  if (!input.startsWith("/")) return [];

  const search = input.slice(1).toLowerCase().trim();
  if (!search) return registry.getAll();

  return registry
    .getAll()
    .filter(
      (command) =>
        command.name.startsWith(search) ||
        command.aliases?.some((alias) => alias.startsWith(search)),
    );
}
