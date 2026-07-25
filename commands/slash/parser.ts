import type { ParsedCommand } from "./types";

export function parseInput(input: string): ParsedCommand {
  const trimmed = input.trim();

  //discovery mode
  if (trimmed === "/") {
    return { type: "discovery", originalInput: input };
  }

  if (!trimmed.startsWith("/")) {
    return { type: "text", originalInput: input };
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0]?.toLowerCase() || "";
  const args = parts.slice(1);

  return {
    type: "command",
    command,
    args,
    originalInput: input,
  };
}
