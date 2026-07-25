import { test, expect } from "bun:test";
import { SlashCommandRegistry } from "../../../commands/slash/registry";
import type { SlashCommand } from "../../../commands/slash/types";

test("registry: register and get command", () => {
  const registry = new SlashCommandRegistry();
  
  const testCommand: SlashCommand = {
    name: "test",
    description: "Test command",
    category: "other",
    async execute() {
      return "test";
    },
  };
  
  registry.register(testCommand);
  
  const retrieved = registry.get("test");
  expect(retrieved).toEqual(testCommand);
});

test("registry: get command by alias", () => {
  const registry = new SlashCommandRegistry();
  
  const testCommand: SlashCommand = {
    name: "help",
    aliases: ["h", "?"],
    description: "Help command",
    category: "other",
    async execute() {
      return "help";
    },
  };
  
  registry.register(testCommand);
  
  expect(registry.get("h")).toEqual(testCommand);
  expect(registry.get("?")).toEqual(testCommand);
  expect(registry.get("help")).toEqual(testCommand);
});

test("registry: get unknown command returns undefined", () => {
  const registry = new SlashCommandRegistry();
  expect(registry.get("unknown")).toBeUndefined();
});

test("registry: getAll returns all commands", () => {
  const registry = new SlashCommandRegistry();
  
  const cmd1: SlashCommand = {
    name: "cmd1",
    description: "Command 1",
    category: "session",
    async execute() {
      return "1";
    },
  };
  
  const cmd2: SlashCommand = {
    name: "cmd2",
    description: "Command 2",
    category: "configuration",
    async execute() {
      return "2";
    },
  };
  
  registry.register(cmd1);
  registry.register(cmd2);
  
  const all = registry.getAll();
  expect(all).toHaveLength(2);
  expect(all).toContain(cmd1);
  expect(all).toContain(cmd2);
});

test("registry: getByCategory filters correctly", () => {
  const registry = new SlashCommandRegistry();
  
  const sessionCmd: SlashCommand = {
    name: "new",
    description: "New session",
    category: "session",
    async execute() {
      return "new";
    },
  };
  
  const configCmd: SlashCommand = {
    name: "provider",
    description: "Provider config",
    category: "configuration",
    async execute() {
      return "provider";
    },
  };
  
  registry.register(sessionCmd);
  registry.register(configCmd);
  
  const sessionCommands = registry.getByCategory("session");
  expect(sessionCommands).toHaveLength(1);
  expect(sessionCommands[0]).toEqual(sessionCmd);
  
  const configCommands = registry.getByCategory("configuration");
  expect(configCommands).toHaveLength(1);
  expect(configCommands[0]).toEqual(configCmd);
});

test("registry: generateDiscoveryList returns formatted list", () => {
  const registry = new SlashCommandRegistry();
  
  const cmd1: SlashCommand = {
    name: "help",
    description: "Help",
    category: "other",
    async execute() {
      return "help";
    },
  };
  
  const cmd2: SlashCommand = {
    name: "exit",
    description: "Exit",
    category: "session",
    async execute() {
      return "exit";
    },
  };
  
  registry.register(cmd1);
  registry.register(cmd2);
  
  const list = registry.generateDiscoveryList();
  expect(list).toContain("/help");
  expect(list).toContain("/exit");
});

test("registry: generateHelp includes all commands", () => {
  const registry = new SlashCommandRegistry();
  
  const helpCmd: SlashCommand = {
    name: "help",
    aliases: ["h"],
    description: "Show help",
    category: "other",
    async execute() {
      return "help";
    },
  };
  
  registry.register(helpCmd);
  
  const help = registry.generateHelp();
  expect(help).toContain("/help");
  expect(help).toContain("(h)");
  expect(help).toContain("Show help");
});
