# Woopcode

[![npm version](https://badge.fury.io/js/woopcode.svg)](https://www.npmjs.com/package/woopcode)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Open-source AI coding agent for developers who live in the terminal.**

Woopcode is a terminal-native AI assistant that understands your repository, executes tools, and streams every step in real time. No context switching, no web UI—just you, your terminal, and an AI that actually sees your codebase.

<!-- Demo GIF: Terminal recording showing interactive agent session -->

---

## Features

- **Streaming agent runtime** - Watch the AI think and act in real-time
- **Repository-aware** - Automatically loads your project context
- **Tool execution** - Read files, run commands, make edits—autonomously
- **Diff approvals** - Review every file change before it's applied
- **Multi-provider** - Swap between Gemini, Claude, GPT without config changes
- **Terminal-first** - Full keyboard control, no mouse required
- **Slash commands** - Quick commands like `/status`, `/help`, `/new`
- **Built with Bun** - Fast, modern, native TypeScript support

---

## Installation

```bash
# Run without installing
bunx woopcode

# Install globally
bun add -g woopcode
# or
npm install -g woopcode
```

---

## Quick Start

```bash
# First run launches setup wizard
woopcode

# Agent starts in your current directory
cd ~/my-project
woopcode
```

**Example prompts:**
```
> Explain the architecture of this repository
> Fix the failing tests in auth.test.ts
> Refactor database.ts to use async/await
> Find all TODO comments
> Generate unit tests for the API handlers
```

**Slash commands:**
```
/help       Show available commands
/status     System status (provider, model, workspace)
/new        Start fresh conversation
/provider   Switch AI provider
/exit       Quit
```

---

## Why Woopcode?

Most AI coding tools run in your editor or browser. Woopcode is different:

**Terminal-native**  
No context switching. Stay in your terminal, stay in flow.

**Repository context**  
Automatically loads `package.json`, `README.md`, file tree. The AI knows your project.

**Real-time streaming**  
See the agent's reasoning as it happens. Watch tools execute. Cancel anytime.

**Approval-based edits**  
Every file change shown as a unified diff. Accept, reject, or cancel.

**Provider-agnostic**  
Switch between Google Gemini, Anthropic Claude, OpenAI GPT. Same workflow, different model.

**Extensible**  
Add custom tools in ~10 lines of TypeScript. Plugin system coming soon.

---

## Architecture

```
User Input
    ↓
Agent Controller (manages conversation state)
    ↓
Streaming Runtime (LLM → tool calls → results)
    ↓
Tool Registry (9 built-in tools: read, write, edit, search, run, test)
    ↓
Provider Client (Gemini | Claude | GPT)
    ↓
Terminal UI (React Ink)
```

**Core loop:**
1. User sends prompt
2. LLM streams response + tool calls
3. Tools execute (with approval for file edits)
4. Results feed back to LLM
5. Loop continues until completion (max 10 iterations)

**Safety:**
- Tool loop detection (no infinite cycles)
- File change approvals (unified diff preview)
- Cancellation support (Ctrl+C anytime)
- Conversation persistence (all history saved locally)

[Full architecture docs →](./docs/architecture.md)

---

## Built-in Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Overwrite existing file |
| `edit_file` | Replace text within file |
| `create_file` | Create new file |
| `list_files` | List repository structure |
| `find_files` | Find files by name/pattern |
| `grep` | Search file contents |
| `run_terminal` | Execute shell commands |
| `run_tests` | Run project tests |

File-modifying tools (`write`, `edit`, `create`) trigger approval workflow with diff preview.

[Tool reference →](./docs/tools.md)

---

## Provider Support

| Provider | Status | Models |
|----------|--------|--------|
| **Google Gemini** | ✅ Supported | gemini-3.5-flash-lite |
| **Anthropic** | 🚧 Planned | claude-sonnet-4 |
| **OpenAI** | 🚧 Planned | gpt-5.5 |
| **Groq** | 🚧 Planned | - |

```bash
# Manage providers
woopcode providers list
woopcode providers login -p google -a YOUR_KEY
woopcode providers set -p google

# Or use slash commands in-app
/provider           # Show current provider
/login google KEY   # Login from within app
/logout             # Logout
```

[Provider setup →](./docs/providers.md)

---

## Development

```bash
# Clone repository
git clone https://github.com/mangit955/woop-code.git
cd woop-code

# Install dependencies
bun install

# Run locally
bun cli.ts

# Run tests
bun test

# Type checking
bunx tsc --noEmit
```

**Add a custom tool:**
```typescript
// tools/myTool.ts
export const myTool: Tool = {
  name: "my_tool",
  description: "What the tool does",
  parameters: [
    { name: "input", description: "Input param", required: true }
  ],
  async execute(args) {
    return "Result";
  }
};
```

Register in `tools/index.ts` and you're done.

[Development guide →](./docs/development.md)

---

## Roadmap

- [x] Streaming agent runtime
- [x] Tool execution system
- [x] Diff approval workflow
- [x] Google Gemini provider
- [x] Slash commands
- [x] Onboarding wizard
- [ ] Anthropic Claude provider
- [ ] OpenAI GPT provider
- [ ] Plugin system
- [ ] Multi-file editing
- [ ] Conversation search
- [ ] Custom system prompts

[Full roadmap →](./docs/roadmap.md)

---

## Documentation

- [Architecture](./docs/architecture.md) - How Woopcode works under the hood
- [Tools](./docs/tools.md) - Built-in tools and how to add custom ones
- [Providers](./docs/providers.md) - AI provider setup and configuration
- [Slash Commands](./docs/slash-commands.md) - Quick reference for all commands
- [Testing](./docs/testing.md) - Test philosophy and running tests
- [Development](./docs/development.md) - Contributing and extending Woopcode
- [Configuration](./docs/configuration.md) - Config files and customization

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

**Quick start:**
1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Credits

Built with [Bun](https://bun.sh), [Ink](https://github.com/vadimdemedes/ink), and [Google Gemini](https://ai.google.dev/).

Inspired by [Aider](https://github.com/paul-gauthier/aider), [Claude Code](https://www.anthropic.com/), and [Cursor](https://cursor.sh).
