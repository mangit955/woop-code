import type { SlashCommand } from "./types";

export class SlashCommandRegistry {
  private commands = new Map<string, SlashCommand>();
  private aliases = new Map<string, string>();

  register(command: SlashCommand): void {
    this.commands.set(command.name, command);

    if (command.aliases) {
      command.aliases.forEach((alias) => {
        this.aliases.set(alias, command.name);
      });
    }
  }

  get(nameOrAlias: string): SlashCommand | undefined {
    const name = this.aliases.get(nameOrAlias) ?? nameOrAlias;
    return this.commands.get(name);
  }

  getAll(): SlashCommand[] {
    return Array.from(this.commands.values());
  }

  getByCategory(category: string): SlashCommand[] {
    return this.getAll().filter((cmd) => cmd.category === category);
  }

  // Auto-generated help
  generateHelp(): string {
    const categories = {
      session: "Session",
      configuration: "Configuration",
      workspace: "Workspace",
      other: "Other",
    };

    let output = "Available Commands:\n\n";

    for (const [key, label] of Object.entries(categories)) {
      const commands = this.getByCategory(key);
      if (commands.length === 0) continue;

      output += `${label}:\n`;
      commands.forEach((cmd) => {
        const aliases = cmd.aliases?.length
          ? ` (${cmd.aliases.join(", ")})`
          : "";
        output += `  /${cmd.name}${aliases} - ${cmd.description}\n`;
      });
      output += "\n";
    }

    return output.trim();
  }

  // Discovery list
  generateDiscoveryList(): string {
    return this.getAll()
      .map((cmd) => `/${cmd.name}`)
      .join("  ");
  }
}

export const registry = new SlashCommandRegistry();
