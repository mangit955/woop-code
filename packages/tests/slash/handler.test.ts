import { test, expect } from "bun:test";
import { handleSlashCommand } from "../../../commands/slash/handler";
import { registry } from "../../../commands/slash/registry";
import { registerCommands } from "../../../commands/slash/commands";
import type { SlashCommandContext } from "../../../commands/slash/types";

// Register commands before tests
registerCommands();

// Mock context
function createMockContext(): {
  context: SlashCommandContext;
  outputs: string[];
} {
  const outputs: string[] = [];
  
  return {
    context: {
      controller: {} as any,
      onExit: async () => {},
      onOutput: (message: string) => {
        outputs.push(message);
      },
    },
    outputs,
  };
}

test("handler: executes valid command", async () => {
  const { context, outputs } = createMockContext();
  
  const result = await handleSlashCommand("/help", context);
  
  expect(result.handled).toBe(true);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toContain("Available Commands");
});

test("handler: handles unknown command", async () => {
  const { context, outputs } = createMockContext();
  
  const result = await handleSlashCommand("/unknown", context);
  
  expect(result.handled).toBe(true);
  expect(outputs[0]).toContain("Unknown command");
  expect(outputs[0]).toContain("/unknown");
});

test("handler: handles discovery mode", async () => {
  const { context, outputs } = createMockContext();
  
  const result = await handleSlashCommand("/", context);
  
  expect(result.handled).toBe(true);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toContain("/help");
});

test("handler: ignores regular text", async () => {
  const { context, outputs } = createMockContext();
  
  const result = await handleSlashCommand("regular text", context);
  
  expect(result.handled).toBe(false);
  expect(outputs).toHaveLength(0);
});

test("handler: handles command aliases", async () => {
  const { context, outputs } = createMockContext();
  
  const result = await handleSlashCommand("/h", context);
  
  expect(result.handled).toBe(true);
  expect(outputs[0]).toContain("Available Commands");
});

test("handler: version command works", async () => {
  const { context, outputs } = createMockContext();
  
  const result = await handleSlashCommand("/version", context);
  
  expect(result.handled).toBe(true);
  expect(outputs[0]).toContain("Woopcode v");
});
