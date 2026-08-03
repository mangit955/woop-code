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

bun run verify                # the gate over the *unstaged* diff
bun run verify --staged       # over what is staged — what the pre-commit hook runs
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

A bare `bun run verify` reads the **unstaged** diff, so on a fully staged tree it prints "nothing to check" — which looks like a pass and is not one. `--staged` is the one that matches the hook.

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

Providers implement `ProviderClient` in `config/client.ts`, whose `stream()` yields `StreamEvent`s (`text`, `tool_call`, `done`). Google and Anthropic are enabled in `config/providerRegistry.ts`; `openai` is listed with `enabled: false` deliberately. The Gemini client lives in `config/client.ts`, the Anthropic one in `config/anthropicClient.ts`; `createProviderClient` picks between them.

**Anthropic requires the reasoning that preceded a tool call to be replayed with that call's result.** The model pauses mid-response to await the tool and resumes the same response, so its thinking blocks have to come back complete and unmodified — a modified one is a 400, and an omitted one is worse, because the API silently runs that request without thinking. `Message` has nowhere to put them, so `anthropicClient` keeps them for the length of a turn (one client is constructed per turn) and prepends them when rendering. That is why the agent loop, the message type and persistence stay provider-agnostic.

### Invariants that are easy to break

- **Unrecognised shell commands are treated as destructive**, never as safe. Failing closed is the only defensible default for something with write access to a repo.
- **Tool errors are returned to the agent as results**, not thrown out of the turn, so it can correct a bad path and retry. Only the iteration budget ends a turn. Write error messages for the model (`File <path> does not exist`, not `ENOENT`).
- **Persistence drops tool traffic.** Only user and assistant messages are saved; half of a call/result pair would make restored history invalid for the provider.
- **Config failures never block startup.** A corrupt `providers.json` is moved aside and defaults recreated; a malformed approval mode falls back to the default, never to permissive.
- **The workspace boundary is resolved, not string-matched.** Route every path through `resolveWorkspacePath` in `tools/workspace.ts` — it resolves symlinks before the containment check.
- **A context change is judged on billable tokens, not on prompt characters.** The two come apart: enabling tool-history compaction cut peak characters by two thirds and made the run *worse*, because rewriting old messages moves the cache prefix and implicit caching stopped entirely. `runtime/compaction.ts` has the measurements. `bun run replay:baseline` reports characters and says outright that it cannot speak to cache rates.

### Adding a tool

A tool is `{ name, description, parameters, execute(args, signal): Promise<string> }` (`config/types.ts`). Add the file to `tools/`, append it to `toolRegistery` in `tools/index.ts`, add its effect to `TOOL_EFFECTS` in `runtime/toolEffects.ts` (a missing entry reads as `unclassified` — the runtime and the docs both consume this table), then run `bun run docs:extract` and commit the updated `site/src/docs/surface.json`. Nothing in `docs/` names a tool in prose, so pages pick it up automatically; `docs:check` fails if the generated data is stale.

The returned string is what the model sees, so it is interface, not a log line. Bound it — results are truncated at `MAX_TOOL_RESULT` (4,000 chars) before reaching the model, so truncate deliberately with a notice (`tools/readFile.ts` is the one to copy). A tool that writes must raise an approval request rather than writing directly (`tools/editFile.ts`); writing quietly bypasses the diff review the product rests on. Respect the `AbortSignal`.

## Tests

Tests live next to the code (`runtime/`, `tui/`, `config/`, `commands/`) and in `packages/tests/` when they need fixtures or span modules. A bare `bun test` picks up both.

- **Real APIs, not mocks.** Bun's global is readonly, so tools are tested against real files in a temp directory. Only the provider and the approval prompt are faked.
- **`mock.module` is registered for the entire run and cannot be undone.** Restoring it in `afterAll` does nothing (Bun binds static imports at load). A mock must be inert outside its own file: gate it on a flag set in `beforeAll` and cleared in `afterAll`, delegate to the real implementation otherwise, register once against a stable object rather than a fresh one per test, and stub the whole module (spread the real one, override only what you need). `packages/tests/e2e/` shows the shape. The suite once ran green while two persistence tests were quietly asserting against another file's stub.
- Expose order dependence with `bun test $(git ls-files '*.test.ts' '*.test.tsx' | sort -r)`. It only covers tracked files, so a new test that is still untracked is silently skipped by the sweep.
- **The replay fixtures cannot be sent to a live provider.** They carry no `thoughtSignature` — the event log never wrote the field — and `buildContents` in `config/client.ts` documents Gemini refusing function-call parts without one. They reconstruct prompt *sizes* faithfully, which is what the replay harness measures; they are not a recorded conversation you can replay against the API.
- Stubbing a global (`globalThis.fetch`) is the way to fake a network boundary, and is not subject to the `mock.module` trap above — it is per-file and restorable in `afterEach`. `packages/tests/tools/webSearch.integration.test.ts` is the example.
- `packages/tests/README.md` deliberately holds no test counts or file inventories; `bun run docs:lint` enforces that. Don't add them.
- Mutation testing is configured in `stryker.config.json` over the runtime and the write tools, driven by `./run-tests.sh`.

## Benchmarking

Woopcode is benchmarked on Harbor's `terminal-bench-2` as an installed agent: `harbor_woopcode/agent.py` installs the CLI into the task container and runs `woopcode -p` once per task. `harbor_woopcode/README.md` explains why that pattern and not the others. Runs land in `jobs/<name>/`, and `jobs/<name>/<trial>/agent/woopcode-events.jsonl` is the JSONL the `--events` flag writes.

```bash
PYTHONPATH=. harbor run -c harbor_woopcode/job.yaml          # the checked-in five-task config
PYTHONPATH=. harbor run -d terminal-bench/terminal-bench-2 \
  -a harbor_woopcode:WoopCode -m google/gemini-3.5-flash-lite \
  --ak source_dir=$(pwd) -i terminal-bench/overfull-hbox -n 1  # one task
```

`-i` needs the **fully qualified** task name. A bare `overfull-hbox` fails at config validation — which is cheap, because it fails before any container or API call.

Four things that are easy to get wrong:

- **Wall clock is the binding budget, not iterations.** `job.yaml` sets `max_iterations: 200`, but Harbor enforces a per-task agent timeout from the task package and raises `AgentTimeoutError` — 750s for `overfull-hbox`. The baseline run used 191s of that for 59 iterations, so 200 iterations is only reachable if each averages under ~3.7s. Nothing in the loop knows about this budget; the iteration counter is the only one it can see.
- **`agent_timeout_sec: null` in a job's `lock.json` does not mean there is no timeout.** It means that run never hit one. The value only appears in `result.json`'s `exception_info` after it fires.
- **Judge a change on the recorded `durationMs`, not on wall clock.** The loop stamps it around the provider request only, so it is the comparable number; total trial time includes container setup, tool execution and the verifier. Confusing the two once turned a 1.5s baseline into a reported 11s.
- **Provider latency varies enormously and will masquerade as a regression.** The same request shape has measured 1,519ms median across 59 iterations on one day and ~63s on another, and within a single 15-request probe the same configuration ranged from 1,742ms to 90,002ms depending on position in the sequence. Before blaming a code change, check whether latency tracks position rather than the change, and whether the effect is anti-correlated with what you think causes it.

Reading a trajectory, `run_end`'s `ok: true` means the loop finished, not that the task passed — `verifier/reward.txt` is the score. Two trials that reported success with accurate self-verification still scored 0, because they verified the wrong property.

## Environment variables

`WOOPCODE_API_KEY`, `WOOPCODE_PROVIDER`, `WOOPCODE_MAX_ITERATIONS`, `WOOPCODE_MAX_ATTEMPTS` (retry), `WOOPCODE_TOOL_HISTORY_BUDGET`, `WOOPCODE_THINKING_BUDGET`, `WOOPCODE_NON_INTERACTIVE`. Bun loads `.env` automatically — no `dotenv`.

`WOOPCODE_THINKING_BUDGET` takes `off`, `-1` (the default, meaning automatic), or a token count. `off` omits `thinkingConfig` from the request entirely, and exists because `gemini-3.5-flash-lite` rejects a budget of `0` with a 400 — so "disable" cannot be expressed as a number. Budgets below roughly a thousand are ignored rather than honoured: measured, 128 and 512 return zero thinking tokens while 1024 and -1 return 54–202.

That variable is Gemini-shaped, and Anthropic reads it differently because it has to: current Claude models reject `budget_tokens` outright, so a token count has no equivalent there. `off` sends `thinking: {type: "disabled"}`; every other value sends `{type: "adaptive", display: "omitted"}` — the model decides depth, which is what `-1` already meant. The number is not faked into a budget that was never applied.

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
