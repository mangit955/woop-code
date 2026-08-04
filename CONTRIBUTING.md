# Contributing to Woopcode

Thank you for your interest in contributing to Woopcode! This document provides guidelines and instructions for contributing.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) v1.0.0 or higher
- TypeScript knowledge
- Git

### Development Setup

1. Fork the repository on GitHub

2. Clone your fork:
```bash
git clone https://github.com/YOUR_USERNAME/woopcode.git
cd woopcode
```

3. Install dependencies:
```bash
bun install
```

4. Create a feature branch:
```bash
git checkout -b feature/my-feature-name
```

   `bun install` also points git at `.githooks`, so the validation gate runs
   before your commits. If it did not, run `bun run hooks:install`.

5. Configure a provider (for testing):
```bash
bun cli.ts
# Follow the onboarding wizard
```

## Development Workflow

### Running Locally

```bash
# Run the CLI
bun cli.ts

# Run with a specific prompt
bun cli.ts --prompt "Explain this repository"

# Test onboarding flow
bun onboarding/test-reset.ts  # Clear config
bun cli.ts                     # Test onboarding
bun onboarding/test-reset.ts restore  # Restore config
```

### Validation

One command runs whatever your change owes:

```bash
bun run verify          # the working tree
bun run verify --staged # only what is staged; this is what the hook runs
bun run verify --all    # everything, whatever changed
```

The rules, and why each one is there, live in `verify.ts`'s header. In short:

| what you changed | what has to pass |
|---|---|
| a `.ts` or `.tsx` file | `tsc --noEmit`, then `bun test` |
| `tools/`, `commands/slash/`, `runtime/`, `config/version.ts` | the docs surface is still current |
| a `.md` file | the docs lint |

On top of those, the gate reads the lines your change *adds* and rejects a
conflict marker, a credential, a `.only` or `.skip` that would quietly stop a
test running, and Node where Bun has its own (`readFile`/`writeFile`,
`child_process`, and the packages `AGENTS.md` rules out). Existing files are
never re-judged — only what you are adding.

The commit message has to be conventional too; see below.

`.githooks/pre-commit` runs the gate over the staged change and
`.githooks/commit-msg` checks the subject. Both are skipped mid-merge and
mid-rebase, where the tree is half-repaired by definition — CI still has the
last word.

### Type Checking

```bash
bunx tsc --noEmit --skipLibCheck
```

### Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test packages/tests/runtime/agentLoop.test.ts

# Run tests matching a pattern
bun test --test-name-pattern "streaming"

# Run benchmarks
bun run-benchmarks.ts
```

### Code Style

- Use TypeScript strict mode
- Follow existing code conventions
- Use Bun-native APIs over Node.js equivalents
- Prefer functional patterns where appropriate
- Keep functions small and focused

Example:
```typescript
// Good: Bun-native API
const content = await Bun.file(path).text();

// Avoid: Node.js API
const content = await fs.readFile(path, 'utf-8');
```

## Contribution Areas

### Adding Tools

New tools should be added to the `tools/` directory. See [Extending Woopcode](README.md#extending-woopcode) in the README.

**Good candidates for new tools:**
- Git operations (commit, diff, log)
- Code analysis (linting, type checking)
- Documentation generation
- Dependency management
- Database operations

**Tool requirements:**
- Clear, specific purpose
- Safe by default
- Idempotent when possible
- Comprehensive error handling
- Unit tests

### Adding Providers

See the [Provider Implementation Guide](README.md#adding-a-new-provider) in the README.

**Provider requirements:**
- Streaming support
- Tool calling capability
- Proper error handling
- Authentication validation
- Integration tests

### Improving Documentation

Documentation improvements are always welcome:
- README clarifications
- Code comments
- Usage examples
- Architecture diagrams
- Tutorial content

### Fixing Bugs

When fixing bugs:
1. Create an issue describing the bug (if one doesn't exist)
2. Write a failing test that reproduces the bug
3. Fix the bug
4. Ensure the test passes
5. Submit a PR referencing the issue

### Adding Tests

We value comprehensive testing. Test additions are welcome in these categories:

- **Unit tests** - Test individual functions and components
- **Integration tests** - Test tool and provider integration
- **Property tests** - Use fast-check for fuzz testing
- **Golden tests** - Snapshot testing for runtime behavior
- **E2E tests** - Full agent session testing

Place tests in `packages/tests/` following the existing structure.

## Pull Request Process

### Before Submitting

- [ ] `bun run verify --all` passes — tests, types and docs, the three CI gates
- [ ] Tests added for new functionality
- [ ] Documentation updated if needed
- [ ] Commits are clean and well-described

The first line used to be three separate honour-system bullets. They were
honoured right up until they were not: `main` went red because a line in a
Markdown file named a directory that had been renamed, and nothing between the
edit and the push ever ran the check that says so. Hence the gate.

### PR Guidelines

1. **Title**: Clear, concise description
   - Good: "Add OpenAI provider support"
   - Bad: "Update files"

2. **Description**: Explain what and why
   - What problem does this solve?
   - What approach did you take?
   - Any breaking changes?
   - Screenshots/demos if applicable

3. **Size**: Keep PRs focused
   - One feature/fix per PR
   - Break large changes into multiple PRs
   - Easier to review = faster merge

4. **Tests**: Include tests
   - New features require tests
   - Bug fixes should include regression tests
   - Document why tests aren't needed if that's the case

### Review Process

1. Maintainers will review your PR
2. Address any requested changes
3. Once approved, a maintainer will merge

Expected review time: 2-5 days for most PRs.

## Commit Message Guidelines

We use conventional commit messages, and `.githooks/commit-msg` enforces the
subject line. Merges, reverts and `fixup!`/`squash!` are exempt.

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `test:` - Test additions or changes
- `refactor:` - Code refactoring
- `perf:` - Performance improvements
- `chore:` - Maintenance tasks

### Examples

```bash
feat(tools): add git commit tool

Adds a new tool for creating git commits with AI-generated messages.

Closes #123
```

```bash
fix(runtime): prevent infinite tool loops

Tool loop detection now checks both tool name and arguments to properly
detect cycles.
```

```bash
docs(readme): clarify provider setup process

Add step-by-step instructions for obtaining API keys.
```

## Testing Philosophy

### What to Test

- **Public APIs** - All exported functions and classes
- **Error cases** - Invalid inputs, edge cases, failures
- **Integration points** - Tool execution, provider calls
- **Critical paths** - Agent loop, streaming, file operations

### What Not to Test

- Private implementation details (test behavior, not internals)
- Third-party libraries (trust their tests)
- Configuration files (unless logic involved)

### Test Quality

Good tests are:
- **Fast** - Run in milliseconds
- **Isolated** - No dependencies on other tests
- **Deterministic** - Same input always produces same output
- **Readable** - Clear what's being tested and why

Example:
```typescript
import { test, expect } from "bun:test";
import { myFunction } from "./myModule";

test("myFunction handles empty input", () => {
  const result = myFunction("");
  expect(result).toBe(expectedValue);
});

test("myFunction throws on invalid input", () => {
  expect(() => myFunction(null)).toThrow("Invalid input");
});
```

## Project Architecture

Understanding the architecture helps with contributions:

### Key Concepts

**Runtime Loop** (`runtime/loop.ts`)
- Orchestrates agent execution
- Manages streaming from providers
- Executes tools
- Handles errors and cancellation

**Tool System** (`tools/`)
- Uniform interface for agent capabilities
- Tools registered in `tools/index.ts`
- Each tool returns a string result

**Provider Abstraction** (`providers/client.ts`)
- Standardized interface for LLM providers
- Streaming-first design
- Support for tool calling

**TUI** (`tui/src/`)
- React components with Ink
- State management in `store/`
- Handles user input and displays output

## Getting Help

- **Questions**: Open a GitHub Discussion
- **Bugs**: Open a GitHub Issue
- **Security**: Email security@woopcode.dev (if applicable)
- **Chat**: Join our Discord (if available)

## Code of Conduct

Be respectful and constructive. We're all here to build something useful.

- Be patient with newcomers
- Assume good intent
- Give constructive feedback
- Credit others for their work

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to Woopcode! 🚀
