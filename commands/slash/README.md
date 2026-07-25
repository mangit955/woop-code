# Slash Commands

Local commands that execute instantly without invoking the LLM.

## Available Commands

### Session Commands

- **`/new`** (aliases: `clear`, `reset`) - Start a new conversation
- **`/exit`** (aliases: `quit`, `q`) - Exit Woopcode

### Configuration Commands

- **`/provider [name]`** (alias: `p`) - Show current provider or switch to another
  - Without arguments: Shows current provider and all available providers
  - With provider name: Switches to the specified provider (if configured)
  
- **`/model`** (alias: `m`) - Show current model and available models
  - Currently read-only; model switching will be added in future versions

### Workspace Commands

- **`/workspace`** (alias: `ws`) - Show workspace information
  - Displays: workspace name, path, git branch, file count

- **`/status`** (alias: `info`) - Show comprehensive system status
  - Displays: workspace info, provider, model, conversation stats, tools, version

### Other Commands

- **`/help`** (aliases: `h`, `?`) - Show all available commands
- **`/version`** (alias: `v`) - Show Woopcode version

## Discovery Mode

Type `/` alone to see a quick list of all available commands.

## Architecture

The slash command system consists of:

- **Parser** (`parser.ts`) - Parses user input into commands and arguments
- **Registry** (`registry.ts`) - Manages command registration and lookup
- **Handler** (`handler.ts`) - Executes commands and handles errors
- **Commands** (`commands.ts`) - All command implementations

### Adding New Commands

1. Define command in `commands.ts`:

```typescript
const myCommand: SlashCommand = {
  name: "mycommand",
  aliases: ["mc", "mycmd"],
  description: "Does something useful",
  category: "other", // session | configuration | workspace | other
  
  async execute(context, args) {
    // Implementation
    return "Command output";
  }
};
```

2. Register in `registerCommands()`:

```typescript
export function registerCommands() {
  // ... existing commands
  registry.register(myCommand);
}
```

That's it! The command will automatically appear in `/help` and support tab completion.

## Integration

Slash commands are intercepted in `tui/src/prompt.tsx` before being sent to the agent:

```typescript
const result = await handleSlashCommand(prompt, context);

if (result.handled) {
  // Command was executed, don't send to LLM
  return;
}

// Otherwise continue to agent
await controller.run(prompt);
```

## Testing

Tests are located in `packages/tests/slash/`:

- `parser.test.ts` - Parser logic
- `registry.test.ts` - Command registry
- `handler.test.ts` - Command execution

Run tests:

```bash
bun test packages/tests/slash/
```
