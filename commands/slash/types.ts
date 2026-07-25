import type { AgentController } from "../agentController";

export interface SlashCommandContext {
  controller: AgentController;
  onExit: () => Promise<void>;
  onOutput: (message: string) => void;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  category: "session" | "configuration" | "workspace" | "other";
  usage?: string;
  execute(context: SlashCommandContext, args: string[]): Promise<string>;
}

export interface ParsedCommand {
  type: "command" | "text" | "discovery";
  command?: string;
  args?: string[];
  originalInput?: string;
}
