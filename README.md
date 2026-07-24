# Woopcode

**An autonomous AI coding assistant built for the terminal.**

Woopcode combines a streaming agent runtime, extensible tool system, and provider abstraction to help developers read, modify, and execute code directly from the command line. It operates within your project directory, with full access to your repository context.

Built with [Bun](https://bun.sh) and React [Ink](https://github.com/vadimdemedes/ink) for a fast, modern terminal experience.

<!-- Demo GIF: Terminal recording showing interactive agent session -->

---

## Why Woopcode?

Most AI coding tools either run in your editor or operate as web services. Woopcode is different:

- **Terminal-native**: Full keyboard-driven workflow with no context switching
- **Streaming runtime**: See agent reasoning and tool execution in real-time
- **Approval-based editing**: Review all file changes as unified diffs before applying
- **Repository-aware**: Automatically loads project context (package.json, README, file tree)
- **Provider-agnostic**: Swap between AI providers without changing your workflow
- **Extensible**: Add custom tools and providers through a clean TypeScript API

Woopcode is designed for developers who want the power of AI assistance without leaving their terminal.

---

## Features

### AI Runtime

- **Streaming responses** - Text streams character-by-character as the model generates
- **Tool execution** - Agent autonomously calls tools to inspect and modify your codebase
- **Conversation persistence** - Session history saved locally in JSON format
- **Cancellation support** - Interrupt agent execution at any time with Ctrl+C
- **Loop detection** - Prevents infinite tool call cycles
- **Iteration limits** - Configurable max iterations (default: 10) and turn window (default: 8)

### Built-in Tools

The agent has access to 9 filesystem and execution tools:

| Tool | Description |
|------|-------------|
| `list_files` | Recursively list repository structure |
| `find_files` | Find files by name or pattern |
| `read_file` | Read file contents |
| `grep` | Search file contents with regex |
| `create_file` | Create new files |
| `write_file` | Overwrite existing files |
| `edit_file` | Replace specific text within files |
| `run_terminal` | Execute shell commands |
| `run_tests` | Run project test suite |

All file-modifying tools (`write_file`, `edit_file`) trigger an approval workflow with diff preview.

### Interactive TUI

- **React-based interface** - Smooth rendering with Ink
- **Syntax highlighting** - Code blocks and markdown formatting
- **Diff preview** - Unified diff view for all file edits
- **Real-time status** - Current agent action displayed at all times
- **Keyboard shortcuts** - Navigate and approve changes without touching the mouse

### Provider Support

| Provider | Status | Models |
|----------|--------|--------|
| Google Gemini | ✅ Supported | gemini-3.5-flash-lite |
| OpenAI | 🚧 Planned | - |
| Anthropic | 🚧 Planned | - |
| Groq | 🚧 Planned | - |

---

## Installation

### From Source

```bash
# Clone repository
git clone https://github.com/yourusername/woopcode.git
cd woopcode

# Install dependencies
bun install

# Run locally
bun cli.ts
```

### Global Install (Coming Soon)

```bash
bun add -g woopcode
```

---

## Quick Start

### First-Time Setup

When you run Woopcode for the first time, it launches an interactive onboarding wizard:

```bash
woopcode
```

The wizard guides you through:
1. Selecting an AI provider (currently Google Gemini)
2. Obtaining an API key
3. Validating and saving your configuration

### Basic Usage

Once configured, Woopcode operates in your current directory:

```bash
cd ~/my-project
woopcode
```

The agent automatically loads repository context and enters an interactive session.

### Example Prompts

```
> Explain the architecture of this repository

> Create a README documenting the key modules

> Refactor the authentication logic to use async/await

> Find all TODO comments in the codebase

> Generate unit tests for the runtime module

> Review recent git changes and suggest improvements
```

### Provider Management

```bash
# List available providers
woopcode providers list

# Login to a provider
woopcode providers login -p google -a YOUR_API_KEY

# Change active provider
woopcode providers set -p google

# Logout
woopcode providers logout
```

---

## Architecture

Woopcode is organized into distinct layers, each with a clear responsibility:

```
┌─────────────────────────────────────────┐
│              User / CLI                 │  Interactive terminal interface
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│         Agent Controller                │  Manages conversation, handles UI updates
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│         Agent Runtime                   │  Streaming loop, iteration control, tool orchestration
└──────────────┬──────────────────────────┘
               │
        ┌──────┴──────┐
        │             │
┌───────▼────┐  ┌─────▼──────┐
│  Provider  │  │    Tool    │
│  Client    │  │  Registry  │            Provider abstraction and tool system
└───────┬────┘  └─────┬──────┘
        │             │
┌───────▼─────────────▼────────┐
│  Filesystem / Network / LLM  │           External systems
└──────────────────────────────┘
```

### Core Components

#### Runtime (`config/runtime.ts`)

The agent runtime implements a streaming request-response loop:

1. **Message Construction** - Recent conversation turns (default: 8) + repository context sent to provider
2. **Stream Processing** - Text and tool calls streamed from the LLM
3. **Tool Execution** - Tool calls intercepted and executed locally
4. **Result Injection** - Tool outputs appended to conversation
5. **Iteration** - Loop continues until agent responds with text or hits iteration limit (default: 10)

Key safety features:
- Tool loop detection (same tool + arguments cannot be called twice)
- Iteration limits prevent infinite loops
- Cancellation support via AbortSignal
- Tool result truncation (max 4000 characters)

#### Provider Abstraction (`config/client.ts`)

Providers implement a single interface:

```typescript
interface ProviderClient {
  stream(
    messages: Message[],
    repoContext: string,
    signal?: AbortSignal
  ): AsyncGenerator<StreamEvent>;
}
```

This abstraction allows swapping LLM providers without changing runtime logic.

#### Tool System (`tools/`)

Tools follow a consistent interface:

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter[];
  execute(args: Record<string, unknown>): Promise<string>;
}
```

Example tool implementation (`tools/editFile.ts`):

```typescript
export const editFileTool: Tool = {
  name: "edit_file",
  description: "Replace text inside an existing file.",
  
  parameters: [
    { name: "path", description: "File path", required: true },
    { name: "oldText", description: "Text to replace", required: true },
    { name: "newText", description: "Replacement text", required: true }
  ],

  async execute(args) {
    const path = args.path as string;
    const oldText = args.oldText as string;
    const newText = args.newText as string;
    
    const content = await Bun.file(path).text();
    const updated = content.replace(oldText, newText);
    
    // Generate diff and request approval
    const diff = createTwoFilesPatch(path, path, content, updated);
    const approved = await store.setPendingEdit({ path, diff, ... });
    
    if (!approved) return `Edit rejected for ${path}`;
    
    await Bun.write(path, updated);
    return `Edited ${path}`;
  }
};
```

#### Configuration (`config/`)

Configuration is stored locally in JSON files:

- `config/providers.json` - Provider settings and API keys
- `config/conversation.json` - Persistent conversation history
- `config/models.json` - Available models per provider

#### TUI (`tui/src/`)

Built with React and Ink, the terminal UI includes:

- `App` - Main application component with input handling
- `HomeScreen` - Initial screen with prompt examples and capabilities
- `DiffPreview` - Unified diff viewer for file edits
- `CodeBlock` - Syntax-highlighted code rendering
- `BootScreen` - Animated startup sequence

---

## Repository Structure

```
woopcode/
├── cli.ts                   # CLI entry point
├── commands/
│   ├── agent.tsx            # Interactive agent command
│   ├── agentController.ts   # Agent lifecycle management
│   ├── models.ts            # Model listing command
│   └── providers/           # Provider management commands
├── config/
│   ├── runtime.ts           # Agent loop implementation
│   ├── client.ts            # Provider client factory
│   ├── authProvider.ts      # Provider authentication
│   ├── systemPrompt.ts      # Agent system prompt
│   ├── types.ts             # Core type definitions
│   └── *.json               # Configuration storage
├── tools/
│   ├── index.ts             # Tool registry
│   ├── readFile.ts          # Read file tool
│   ├── editFile.ts          # Edit file tool
│   ├── writeFile.ts         # Write file tool
│   ├── createFile.ts        # Create file tool
│   ├── listFiles.ts         # List files tool
│   ├── findFiles.ts         # Find files tool
│   ├── grep.ts              # Grep tool
│   ├── terminal.ts          # Terminal execution tool
│   └── runTests.ts          # Test runner tool
├── tui/
│   └── src/
│       ├── app.tsx          # Main TUI component
│       ├── components/      # React components
│       └── store/           # State management
├── onboarding/
│   ├── index.ts             # First-run setup wizard
│   ├── setupWizard.tsx      # Interactive onboarding UI
│   └── providers.ts         # Provider registry
└── packages/
    └── tests/               # Comprehensive test suite
        ├── bench/           # Benchmarks
        ├── contracts/       # Contract tests
        ├── e2e/             # End-to-end tests
        ├── goldens/         # Golden file tests
        ├── property/        # Property-based tests
        ├── performance/     # Performance tests
        └── runtime/         # Runtime tests
```

---

## Testing

Woopcode includes a comprehensive test suite with multiple testing strategies:

### Test Categories

| Type | Count | Purpose |
|------|-------|---------|
| **Unit Tests** | ~10 | Component and function-level testing |
| **Integration Tests** | ~4 | Tool and provider integration |
| **Property Tests** | ~5 | Fuzz testing with fast-check |
| **Golden Tests** | ~4 | Snapshot testing for runtime behavior |
| **E2E Tests** | ~2 | Full agent session testing |
| **Benchmarks** | ~3 | Performance regression tracking |

### Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test packages/tests/runtime/agentLoop.test.ts

# Run benchmarks
bun run-benchmarks.ts

# Run with coverage (using Stryker)
bunx stryker run
```

### Test Philosophy

- **Contract tests** ensure tools and providers conform to interfaces
- **Property tests** verify invariants hold across random inputs
- **Golden tests** detect unintended changes in agent behavior
- **Robustness tests** verify error handling and edge cases
- **Performance tests** catch regressions in streaming and tool execution

---

## Extending Woopcode

### Adding a New Tool

1. Create a new file in `tools/`:

```typescript
// tools/myTool.ts
import type { Tool } from "../config/types";

export const myTool: Tool = {
  name: "my_tool",
  description: "Description for the AI",
  
  parameters: [
    { name: "input", description: "Input parameter", required: true }
  ],
  
  async execute(args) {
    // Implementation
    return "Result string";
  }
};
```

2. Register in `tools/index.ts`:

```typescript
import { myTool } from "./myTool";

export const toolRegistry: Tool[] = [
  // ... existing tools
  myTool
];
```

### Adding a New Provider

1. Implement provider authentication in `config/authProvider.ts`:

```typescript
async function verifyMyProvider(apiKey: string): Promise<boolean> {
  // Validation logic
}
```

2. Implement client in `config/client.ts`:

```typescript
export function myProviderClient(apiKey: string): ProviderClient {
  return {
    async *stream(messages, repoContext, signal) {
      // Streaming implementation
      yield { type: "text", content: "..." };
      yield { type: "tool_call", id: "...", name: "...", arguments: {} };
      yield { type: "done" };
    }
  };
}
```

3. Add to provider registry in `onboarding/providers.ts`:

```typescript
{
  id: "myprovider",
  name: "My Provider",
  enabled: true,
  keyUrl: "https://myprovider.com/api-keys",
  description: "Provider description"
}
```

---

## Development

### Prerequisites

- [Bun](https://bun.sh) v1.0.0 or higher
- TypeScript 5.0+

### Commands

```bash
# Install dependencies
bun install

# Run locally
bun cli.ts

# Run with arguments
bun cli.ts --prompt "Explain this repository"

# Type checking
bunx tsc --noEmit

# Run tests
bun test

# Run specific test
bun test packages/tests/runtime/agentLoop.test.ts

# Run benchmarks
bun run-benchmarks.ts

# Format code
bun run format  # (if configured)
```

### Project Standards

- **TypeScript** - Strict mode enabled
- **Testing** - Aim for >80% coverage on core runtime logic
- **Bun APIs** - Prefer `Bun.file`, `Bun.$`, `Bun.write` over Node.js equivalents
- **No dependencies on Node.js** - Use Bun-native APIs throughout

---

## Roadmap

Current status and planned features:

- [x] Streaming agent runtime
- [x] Tool execution system
- [x] Provider abstraction layer
- [x] Interactive TUI with Ink
- [x] Diff preview and approval workflow
- [x] Google Gemini provider
- [x] First-run onboarding wizard
- [x] Comprehensive test suite
- [ ] OpenAI provider support
- [ ] Anthropic Claude provider support
- [ ] Plugin system for third-party tools
- [ ] Session history improvements (search, replay)
- [ ] Multi-file editing workflow
- [ ] Configurable system prompts
- [ ] Remote provider support (API keys stored securely)

---

## Contributing

Contributions are welcome! Here's how to get started:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Add tests for new functionality
5. Run the test suite (`bun test`)
6. Commit your changes (`git commit -m 'Add my feature'`)
7. Push to your branch (`git push origin feature/my-feature`)
8. Open a Pull Request

### Guidelines

- Follow existing code style and conventions
- Add tests for new features
- Update documentation as needed
- Keep commits focused and atomic
- Write clear commit messages

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Credits

Built with:
- [Bun](https://bun.sh) - Fast JavaScript runtime
- [Ink](https://github.com/vadimdemedes/ink) - React for CLIs
- [Google Gemini](https://ai.google.dev/) - AI provider
- [Commander.js](https://github.com/tj/commander.js) - CLI framework
- [diff](https://github.com/kpdecker/jsdiff) - Unified diff generation

Inspired by [Aider](https://github.com/paul-gauthier/aider), [Claude Code](https://www.anthropic.com/), and [Cursor](https://cursor.sh).
