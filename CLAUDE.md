# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Woopcode is a terminal-native coding agent (React Ink TUI + streaming agent loop) published to npm as `woopcode`. TypeScript throughout, running on Bun.

## Commands

```bash
bun install
bun run start                 # or: bun cli.ts — launch the interactive agent
bun cli.ts --prompt "..."     # headless single-turn path

bun test                                            # whole suite (unit + integration + property + e2e)
bun test packages/tests/runtime/agentLoop.test.ts   # one file
bun test packages/tests/tools                       # one directory
bun test --test-name-pattern "streaming"            # by test name
bun run test                                        # bun test + tsc --noEmit (what CI runs)
bunx --no-install tsc --noEmit                      # type check alone

bun run verify                # the gate: the checks this change owes, and nothing else
bun run verify --all          # every check, whatever changed
bun run hooks:install         # point git at .githooks (bun install does this too)

bun run docs:extract          # regenerate site/src/docs/surface.json from the code
bun run docs:check            # extract --check + docs lint; CI gate
bun run site                  # documentation and marketing site, with hot reload

bun run-benchmarks.ts         # benchmarks
bun run replay:baseline       # replay harness over packages/tests/fixtures/replay
bun onboarding/test-reset.ts  # clear local config to test onboarding (`restore` puts it back)
```

CI (`.github/workflows/ci.yml`) gates on three things: `bun test` on ubuntu **and** macOS, `tsc --noEmit`, and `docs:check`. Both OSes run because the approval classifier and the config loader depend on path semantics that differ between them.

Those same three run before a commit rather than after a push. `verify.ts` holds the rules — which of the checks a change owes, read from the paths it touched, plus a handful the diff can answer on its own (conflict markers, a staged key, a silenced test, Node where Bun has its own). `.githooks/pre-commit` runs it over what is staged, `.githooks/commit-msg` checks the subject is conventional, and a `PreToolUse` hook in `.claude/settings.json` runs it again for the agent, because `--no-verify` walks past a git hook. Every rule and its reasoning is in `verify.ts`'s header.

## Architecture

```text
cli.ts              argument parsing, subcommands (commander)
  commands/         AgentController, slash commands, provider/model subcommands
    tui/            the React Ink interface
  config/           the agent loop, provider client, repo context, persistence
    runtime/        approval classification/policy, compaction, retry, logs
      tools/        the tool registry
```

Two structural facts to know before editing:

- **The agent loop lives in `config/runtime.ts`, not in `commands/`.** It knows nothing about the interface, which is what lets the same loop drive both the TUI and the headless `--prompt` path. Everything flows back out through `AgentCallbacks` (text, tool start, tool finish, error).
- **Approval is split in two.** `runtime/approval/classifier.ts` decides how risky a shell command is; `runtime/approval/policy.ts` decides whether that risk needs asking. Adding an approval mode is one entry in a table.

A turn: `cli.ts` → `AgentController` (owns client, model, cancellation) → `buildRepositoryContext` in `config/config.ts` (package metadata, README, agent instruction files, structure — each capped, the whole capped again) → `agentLoop` in `config/runtime.ts` (stream, collect tool calls, execute, feed results back; 20 iterations by default) → tools resolved via `toolRegistery` in `tools/index.ts`.

Providers implement `ProviderClient` in `config/client.ts`, whose `stream()` yields `StreamEvent`s (`text`, `tool_call`, `done`). Only the Google entry is enabled in `config/providerRegistry.ts`; `openai` and `anthropic` are listed with `enabled: false` deliberately.

### Invariants that are easy to break

- **Unrecognised shell commands are treated as destructive**, never as safe. Failing closed is the only defensible default for something with write access to a repo.
- **Tool errors are returned to the agent as results**, not thrown out of the turn, so it can correct a bad path and retry. Only the iteration budget ends a turn. Write error messages for the model (`File <path> does not exist`, not `ENOENT`).
- **Persistence drops tool traffic.** Only user and assistant messages are saved; half of a call/result pair would make restored history invalid for the provider.
- **Config failures never block startup.** A corrupt `providers.json` is moved aside and defaults recreated; a malformed approval mode falls back to the default, never to permissive.
- **The workspace boundary is resolved, not string-matched.** Route every path through `resolveWorkspacePath` in `tools/workspace.ts` — it resolves symlinks before the containment check.

### Adding a tool

A tool is `{ name, description, parameters, execute(args, signal): Promise<string> }` (`config/types.ts`). Add the file to `tools/`, append it to `toolRegistery` in `tools/index.ts`, add its effect to `TOOL_EFFECTS` in `runtime/toolEffects.ts` (a missing entry reads as `unclassified` — the runtime and the docs both consume this table), then run `bun run docs:extract` and commit the updated `site/src/docs/surface.json`. Nothing in `docs/` names a tool in prose, so pages pick it up automatically; `docs:check` fails if the generated data is stale.

The returned string is what the model sees, so it is interface, not a log line. Bound it — results are truncated at `MAX_TOOL_RESULT` (4,000 chars) before reaching the model, so truncate deliberately with a notice (`tools/readFile.ts` is the one to copy). A tool that writes must raise an approval request rather than writing directly (`tools/editFile.ts`); writing quietly bypasses the diff review the product rests on. Respect the `AbortSignal`.

## Tests

Tests live next to the code (`runtime/`, `tui/`, `config/`, `commands/`) and in `packages/tests/` when they need fixtures or span modules. A bare `bun test` picks up both.

- **Real APIs, not mocks.** Bun's global is readonly, so tools are tested against real files in a temp directory. Only the provider and the approval prompt are faked.
- **`mock.module` is registered for the entire run and cannot be undone.** Restoring it in `afterAll` does nothing (Bun binds static imports at load). A mock must be inert outside its own file: gate it on a flag set in `beforeAll` and cleared in `afterAll`, delegate to the real implementation otherwise, register once against a stable object rather than a fresh one per test, and stub the whole module (spread the real one, override only what you need). `packages/tests/e2e/` shows the shape. The suite once ran green while two persistence tests were quietly asserting against another file's stub.
- Expose order dependence with `bun test $(git ls-files '*.test.ts' '*.test.tsx' | sort -r)`.
- `packages/tests/README.md` deliberately holds no test counts or file inventories; `bun run docs:lint` enforces that. Don't add them.
- Mutation testing is configured in `stryker.config.json` over the runtime and the write tools, driven by `./run-tests.sh`.

## Environment variables

`WOOPCODE_API_KEY`, `WOOPCODE_PROVIDER`, `WOOPCODE_MAX_ITERATIONS`, `WOOPCODE_MAX_ATTEMPTS` (retry), `WOOPCODE_TOOL_HISTORY_BUDGET`, `WOOPCODE_NON_INTERACTIVE`. Bun loads `.env` automatically — no `dotenv`.

User state (config, conversation, execution log) lives in `~/.config/woopcode/` (`%LOCALAPPDATA%\woopcode\` on Windows), never in the repo.

## Conventions

Skills for the procedures that are multi-step and easy to half-do live in
`.claude/skills/` — adding a tool, changing what the prompt carries, writing a
test, and touching approval. Each ends in the command that checks it. Read the
matching one before starting that kind of work.

Before you do any work, mention how you could verify that work — the test, command, or observation that would show it actually worked. If a change can't be verified, say so before making it.

Conventional commits (`feat(tools):`, `fix(runtime):`, …), TypeScript strict mode, small focused functions.

Bun over Node throughout — the full rule is in `AGENTS.md` and `.cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc`:

- `bun <file>`, `bun test`, `bun install`, `bun build`, `bunx` — never node/npm/pnpm/vite/jest/webpack.
- `Bun.file` over `node:fs` read/write, `Bun.$` over execa, built-in `WebSocket`, `Bun.serve()` over express, `bun:sqlite` over better-sqlite3.
- The site uses `Bun.serve()` with HTML imports; no bundler config.
