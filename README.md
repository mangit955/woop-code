# WoopCode Agent Framework

> **WoopCode** is a cutting-edge autonomous software engineering agent and TUI (Terminal User Interface) framework built for modern developers. It combines powerful LLM capabilities with safe, sandboxed local tool execution.

---

## Getting Started

Follow these steps to set up and run WoopCode in your local environment.

### Prerequisites

Make sure you have the following installed on your system:

1. **Node.js** (v18.0.0 or higher recommended)
2. **Bun** (v1.0.0 or higher for lightning-fast package management and execution)
3. **TypeScript** (v5.0+)

### Installation

Clone the repository and install dependencies using `bun`:

```bash
git clone https://github.com/woopcode/woopcode.git
cd woopcode
bun install
```

---

## Core Features

WoopCode provides a comprehensive suite of tools and interfaces for autonomous development:

- **Interactive TUI**
  - Built with React and Ink for smooth terminal rendering.
  - Real-time message streaming and timeline management.
  - Syntax highlighting for markdown and code blocks.
- **Diff Preview Workflow**
  - AI never overwrites files immediately.
  - All edits displayed as unified diffs before applying.
  - User approval required (A=Apply, R=Reject, Esc=Cancel).
  - Works with both `write_file` and `edit_file` tools.
- **Autonomous Tool Execution**
  - File System Operations:
    - Reading, writing, and patching files.
    - Recursive directory scanning.
  - Environment & Shell Execution:
    - Running terminal commands safely.
    - Automated test suite execution.

---

## Architecture & Code Examples

Here is a quick overview of how core components are structured in TypeScript.

### 1. Tool Definition Interface

```typescript
export interface ToolDefinition<TParams = any, TResult = any> {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute(params: TParams): Promise<TResult>;
}
```

### 2. Agent Execution Loop

```typescript
import { AgentController } from "./commands/agentController";

async function runAgent(prompt: string) {
  const controller = new AgentController();
  console.log(`Starting agent task: "${prompt}"`);

  const result = await controller.executeTask({
    prompt,
    maxIterations: 10,
    sandbox: true,
  });

  console.log(`Task completed with status: *${result.status}*`);
}
```

### Configuration Format

Here is an example `config.json` configuration file used to manage agent providers and settings:

```json
{
  "provider": "google",
  "model": "gemini-2.5-pro",
  "temperature": 0.2,
  "maxTokens": 4096,
  "sandboxed": true
}
```

---

## Configuration Matrix

| Setting       | Type      | Default    | Description                       |
| ------------- | --------- | ---------- | --------------------------------- |
| `provider`    | `string`  | `"google"` | Active AI model provider          |
| `temperature` | `number`  | `0.2`      | Controls randomness in generation |
| `sandboxed`   | `boolean` | `true`     | Restricts shell command execution |
| `maxTokens`   | `number`  | `4096`     | Maximum output token limit        |

---

## License

This project is licensed under the **MIT License**. See the `LICENSE` file for details. _Contributions are always welcome!_
