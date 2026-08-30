# CLAUDE.md

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
commands/           AgentController, slash commands, provider/model subcommands
  tui/              the React Ink interface
runtime/            the agent loop, approval, compaction, retry, logs
providers/          the three provider clients, the registry, the model catalog
config/             repo context, persistence, paths, the system prompt, types
tools/              the tool registry
```

The agent loop is `runtime/loop.ts`. It knows nothing about the interface, which is what lets the same loop drive both the TUI and the headless `--prompt` path; everything flows back out through `AgentCallbacks` (text, tool start, tool finish, error).

- **Approval is split in two.** `runtime/approval/classifier.ts` decides how risky a shell command is; `runtime/approval/policy.ts` decides whether that risk needs asking. Adding an approval mode is one entry in a table. Risk depends on *where* a command runs as well as what it does: `classifyCommand(cmd, { contained })` lowers machine-level work and out-of-tree writes when the executor is a sandbox, because neither survives a VM that is discarded. It lowers nothing else — `DESTRUCTIVE` still asks, since the sync carries deletions back onto local disk and an unrecognised command lives in that level by design. Containment went into the classifier and not the policy because `requiresApproval` is `risk > ceiling` over a linear enum, so no ceiling can permit `SYSTEM` without also permitting `DESTRUCTIVE`.

A turn: `cli.ts` → `AgentController` (owns client, model, cancellation) → `buildRepositoryContext` in `config/config.ts` (package metadata, README, agent instruction files, structure — each capped, the whole capped again) → `agentLoop` in `runtime/loop.ts` (stream, collect tool calls, execute, feed results back; 40 iterations per stretch, then it asks via `onBudgetExhausted` — absent handler means nobody to ask, and exhaustion throws as before) → tools resolved via `toolRegistry` in `tools/index.ts`.

Providers implement `ProviderClient` in `providers/client.ts`, whose `stream()` yields `StreamEvent`s (`text`, `tool_call`, `done`). Google, OpenAI and Anthropic are all enabled in `providers/providerRegistry.ts`. The Gemini client lives in `providers/client.ts`, the Anthropic one in `providers/anthropicClient.ts`, the OpenAI one in `providers/openaiClient.ts`; `createProviderClient` picks between them.

**Both Anthropic and OpenAI require the reasoning that preceded a tool call to be replayed with that call's result**, and both fail quietly without it — the request is accepted and the model reasons from less than it had, with nothing in the response to notice by. `Message` has nowhere to put reasoning, so each client keeps it for the length of a turn (one client is constructed per turn) and replays it when rendering. That is why the agent loop, the message type and persistence stay provider-agnostic.

The two differ in how they fail and where the trap is. Anthropic pauses mid-response and resumes the same response, so a *modified* thinking block is a 400 — omission is the silent case. OpenAI is stateless by choice (`store: false`, because history is rebuilt from `Message[]` each turn and compaction rewrites it, so `previous_response_id` cannot be used), and its trap is where the item is read from: `encrypted_content` is populated on `response.output_item.done` and **not** on the `.added` that announces the same item, so capturing too early replays an empty husk. `response.output_item.done` also carries a function call's `arguments` whole, so the argument deltas need no accumulating — and a call is identified by `call_id`, not `id`.

Token counts do not mean the same thing across the two. Anthropic's `input_tokens` *excludes* anything cached, so the three counts are summed to get the prompt size; OpenAI's already includes it, with the cached part reported as a breakdown. Reading one client's rule into the other under-reports exactly the turns the cache exists to make cheap.

### Invariants that are easy to break

- **Unrecognised shell commands are treated as destructive**, never as safe. Failing closed is the only defensible default for something with write access to a repo.
- **Plan mode is gated twice, and both are load-bearing.** `runtime/planMode.ts` withholds the writing tools from the provider *and* the loop refuses any write that arrives regardless. The second is not belt-and-braces: `run_terminal` has to stay available for inspection, so `sed -i`, `cat > file` and an inline script that opens a file for writing all reach the disk through a tool the first gate must keep. Deleting either one leaves a mode that only looks safe. The mode is a session property owned by `AgentController`, cycled with Tab, mirrored into the UI store for rendering, and deliberately never persisted — one that survived a restart would swallow the next session's first edit. The loop reads it once per turn, so a Tab mid-turn lands on the next turn.
- **A provider client sends the tool list it was given, never `toolRegistry` directly.** `stream()`'s last parameter is that list, and plan mode narrows it; a client that reads the registry itself offers the model `edit_file` while the session is planning. The OpenAI client shipped doing exactly that — branched before the parameter existed, merged after, no textual conflict — so `packages/tests/providers/offeredTools.test.ts` is driven by `enabledProviderIds()`: a new provider with no probe entry fails the coverage test rather than being quietly exempt. Arguments go through `config/toolSchema.ts`, which is the only copy of that mapping.
- **Tool errors are returned to the agent as results**, not thrown out of the turn, so it can correct a bad path and retry. Only the iteration budget ends a turn. Write error messages for the model (`File <path> does not exist`, not `ENOENT`).
- **Persistence drops tool traffic.** Only user and assistant messages are saved; half of a call/result pair would make restored history invalid for the provider.
- **Config failures never block startup.** A corrupt `providers.json` is moved aside and defaults recreated; a malformed approval mode falls back to the default, never to permissive.
- **The workspace boundary is resolved, not string-matched.** Route every path through `resolveWorkspacePath` in `tools/workspace.ts` — it resolves symlinks before the containment check.
- **A context change is judged on billable tokens, not on prompt characters.** The two come apart: enabling tool-history compaction cut peak characters by two thirds and made the run *worse*, because rewriting old messages moves the cache prefix and implicit caching stopped entirely. `runtime/compaction.ts` has the measurements. `bun run replay:baseline` reports characters and says outright that it cannot speak to cache rates.

### Adding a tool

A tool is `{ name, description, parameters, execute(args, signal): Promise<string> }` (`config/types.ts`). Add the file to `tools/`, append it to `toolRegistry` in `tools/index.ts`, add its effect to `TOOL_EFFECTS` in `runtime/toolEffects.ts` (a missing entry reads as `unclassified` — the runtime and the docs both consume this table, and plan mode withholds anything unclassified), then run `bun run docs:extract` and commit the updated `site/src/docs/surface.json`.

Arguments are described to both providers by `config/toolSchema.ts`, which is the one place that mapping lives. An array parameter holds strings unless it declares `items`, in which case it holds objects — and an `enum` there is enforced by the provider, so an invalid value costs no round trip. Nothing in `docs/` names a tool in prose, so pages pick it up automatically; `docs:check` fails if the generated data is stale.

The returned string is what the model sees, so it is interface, not a log line. Bound it — results are truncated at `MAX_TOOL_RESULT` (4,000 chars) before reaching the model, so truncate deliberately with a notice (`tools/readFile.ts` is the one to copy). A tool that writes must raise an approval request rather than writing directly (`tools/editFile.ts`); writing quietly bypasses the diff review the product rests on. Respect the `AbortSignal`.

## Tests

Tests live next to the code (`runtime/`, `tui/`, `config/`, `commands/`) and in `packages/tests/` when they need fixtures or span modules. A bare `bun test` picks up both.

- **Real APIs, not mocks.** Bun's global is readonly, so tools are tested against real files in a temp directory. Only the provider and the approval prompt are faked.
- **`mock.module` is registered for the entire run and cannot be undone.** Restoring it in `afterAll` does nothing (Bun binds static imports at load). A mock must be inert outside its own file: gate it on a flag set in `beforeAll` and cleared in `afterAll`, delegate to the real implementation otherwise, register once against a stable object rather than a fresh one per test, and stub the whole module (spread the real one, override only what you need). `packages/tests/e2e/` shows the shape. The suite once ran green while two persistence tests were quietly asserting against another file's stub.
- Expose order dependence with `bun test $(git ls-files '*.test.ts' '*.test.tsx' | sort -r)`. It only covers tracked files, so a new test that is still untracked is silently skipped by the sweep.
- **Name a fixture with a UUID, and redirect `XDG_CONFIG_HOME` for the whole file.** `Date.now()` has millisecond resolution, so two runs can build the same fixture path and delete each other's files; and restoring `XDG_CONFIG_HOME` in `afterEach` rather than `afterAll` points the rest of the file at the developer's real `~/.config/woopcode`. Both bugs existed, both passed every sequential sweep, and both only failed when something else touched the tree at the same time. To reproduce that class: `for i in 1 2 3 4; do (bun test > /tmp/load-$i.txt 2>&1 &); done`.
- **The replay fixtures cannot be sent to a live provider.** They carry no `thoughtSignature` — the event log never wrote the field — and `buildContents` in `providers/client.ts` documents Gemini refusing function-call parts without one. They reconstruct prompt *sizes* faithfully, which is what the replay harness measures; they are not a recorded conversation you can replay against the API.
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

- **Both budgets bind, and at `max_iterations: 200` iterations bound first on every task measured.** Harbor enforces a per-task agent timeout from the task package's `task.toml` and raises `AgentTimeoutError`; the loop enforces `WOOPCODE_MAX_WALL_SEC` and stops on whichever binds first. Timeouts vary by 16× across five tasks, so a rule read off any one of them does not generalise — against `jobs/tb2-post-1.1`:

  | task | timeout | wall used | unused | iterations | what stopped it |
  | --- | --- | --- | --- | --- | --- |
  | build-pov-ray | 12000s | 287s | 98% | 79 | model chose to |
  | circuit-fibsqrt | 3600s | 400s | 89% | 165 | model chose to |
  | make-mips-interpreter | 1800s | 406s | **77%** | **200** | **our ceiling** |
  | overfull-hbox | 750s | 192s | 74% | 59 | model chose to |
  | video-processing | 3600s | 261s | 93% | 83 | model chose to |

  `make-mips-interpreter` was killed by its own 200th iteration at 406s of 1800, mid-work, with `exception_info: null` proving Harbor's timeout never fired — so `job.yaml` sets `max_iterations: 1000` and the ceiling reverts to guarding a pathological loop. Harbor does **not** hand the agent its timeout: `AgentContext` has no such field and `Trial` holds `timeout_sec`, so an operator supplies it as `agent_timeout_sec`, which `agent.py` forwards verbatim. `docs/adr/0001-wall-clock-budget-for-the-agent-loop.md` has the measurements and the rejected alternatives.
- **`agent_timeout_sec: null` in a job's `lock.json` does not mean there is no timeout.** It means that run never hit one. The value only appears in `result.json`'s `exception_info` after it fires.
- **Judge a change on the recorded `durationMs`, not on wall clock.** The loop stamps it around the provider request only, so it is the comparable number; total trial time includes container setup, tool execution and the verifier. Confusing the two once turned a 1.5s baseline into a reported 11s.
- **Provider latency varies enormously and will masquerade as a regression.** The same request shape has measured 1,519ms median across 59 iterations on one day and ~63s on another, and within a single 15-request probe the same configuration ranged from 1,742ms to 90,002ms depending on position in the sequence. Before blaming a code change, check whether latency tracks position rather than the change, and whether the effect is anti-correlated with what you think causes it.

Reading a trajectory, `run_end`'s `ok: true` means the loop finished, not that the task passed — `verifier/reward.txt` is the score. Two trials that reported success with accurate self-verification still scored 0, because they verified the wrong property.

## Environment variables

`WOOPCODE_API_KEY`, `WOOPCODE_PROVIDER`, `WOOPCODE_MAX_ITERATIONS`, `WOOPCODE_MAX_WALL_SEC`, `WOOPCODE_MAX_ATTEMPTS` (retry), `WOOPCODE_TOOL_HISTORY_BUDGET`, `WOOPCODE_THINKING_BUDGET`, `WOOPCODE_NON_INTERACTIVE`, `WOOPCODE_DEMO_URL`. Bun loads `.env` automatically — no `dotenv`.

Sandboxing: `E2B_API_KEY`, `WOOPCODE_SANDBOX_TEMPLATE`, `WOOPCODE_SANDBOX_TIMEOUT_MS`, `WOOPCODE_SANDBOX_MAX_FILE_BYTES`, `WOOPCODE_SANDBOX_NETWORK`, `WOOPCODE_SANDBOX_ENV`, `WOOPCODE_SANDBOX_SETUP`.

`WOOPCODE_DEMO_URL` points demo mode at a proxy other than the production one, which is how the proxy is run locally. Demo mode stores a token, not a key: the credential in `providers.json` is only valid against that URL, so the two are written and cleared together (`config/demoAccount.ts`). A shared Gemini key cannot be shipped instead — the free-tier quota belongs to the project rather than the caller, and a key printed in a terminal gets scraped and revoked with no way to replace it.

`WOOPCODE_THINKING_BUDGET` takes `off`, `-1` (the default, meaning automatic), or a token count. `off` omits `thinkingConfig` from the request entirely, and exists because `gemini-3.5-flash-lite` rejects a budget of `0` with a 400 — so "disable" cannot be expressed as a number. Budgets below roughly a thousand are ignored rather than honoured: measured, 128 and 512 return zero thinking tokens while 1024 and -1 return 54–202.

That variable is Gemini-shaped, and the other two read it differently because they have to. Current Claude models reject `budget_tokens` outright, so a token count has no equivalent there: `off` sends `thinking: {type: "disabled"}`, every other value sends `{type: "adaptive", display: "omitted"}` — the model decides depth, which is what `-1` already meant. OpenAI takes an effort level rather than a count, so `off` sends `reasoning: {effort: "none"}` and every other value sends no `reasoning` at all, leaving the model's own default. In neither case is the number faked into a budget that was never applied.

## Sandboxed execution

`--sandbox` (or `/sandbox on`) routes shell commands into an E2B micro-VM instead of running them on the machine. `runtime/sandbox/` holds it: `registry.ts` is the executor in use, `control.ts` turns it on and off, `session.ts` is the lifecycle, `sandboxExecutor.ts` the E2B implementation.

Local disk stays the source of truth for files — the diff review, the editor and git are untouched. Files are pushed before each command and what the command wrote is pulled back after (`sync.ts`, `manifest.ts`).

**The sandbox is a cache.** Local disk is authoritative for input; the sandbox is authoritative only for what a command just wrote. Nothing is merged and no local edit is overwritten. Each command is a transaction against an input snapshot, so afterwards the question is *what did this command do to the exact tree I handed it* rather than "what changed lately" — which cannot tell the command's work from the user's. When both sides changed a file, the user wins and the sandbox's copy lands at `<path>.sandbox`.

Four things that are easy to get wrong:

- **A non-zero exit is a result, not an error.** E2B throws `CommandExitError` for any non-zero exit code. For a coding agent a red suite is the *answer*, so `sandboxExecutor.ts` unwraps it back into a `CommandResult`. Miss this and the model concludes the sandbox is broken every time its own code fails.
- **What may be transmitted is a stricter question than what may be listed.** `walkWorkspace` does not read `.gitignore`, so it would have uploaded this repo's `.env`. `transmittable.ts` uses `git ls-files -co --exclude-standard`, minus an unconditional secret denylist — a force-added `.env` is *tracked*, so git lists it and only the denylist stops it — minus a 1MB size cap, because 93% of this repo is committed marketing video and pushing it cost 22s per session.
- **Fail closed, always.** An unreachable sandbox refuses; it never falls back to local. `repl` runs its interpreter through the executor too, so it is inside whatever boundary the commands are — a local one beside a sandboxed `run_terminal` was an escape hatch via `subprocess.run`. The seam is `Executor.startRepl`, and it is **optional**: an executor that does not implement it is refused rather than answered by starting an interpreter here, so a third kind added later fails closed by default. The driver sources are shared (`tools/replDrivers.ts`) and read their sentinel from the interpreter's *last* argument, because the local executor passes them with `-c`/`-e` while the sandbox writes them to a file — pinned to `argv[1]`, node's sandboxed sentinel becomes the driver's own path and every evaluation hangs until its timeout. Background processes are routed too, so they are no longer the same hole; what a sandboxed one writes comes back at `process_stop`, and one whose sandbox was shut down underneath it reports that rather than creating another. `process_start`'s optional `port` answers with E2B's published URL rather than localhost, because a model told to try localhost concludes its server failed to start.
- **Cancellation is raced, not awaited.** Killing a command and then waiting for it to notice assumes the kill lands; when it does not, `wait()` never settles and the turn hangs with nothing to end it.

Three ways the sync deleted or littered a working tree before it was right, all found by running it:

- **An unusable remote listing must be `null`, never an empty manifest.** Empty is indistinguishable from "the command deleted everything", and the caller acts on that by removing files. The listing prints a sentinel; no sentinel means unusable, and the pull is skipped.
- **Symlinks are never transmitted.** `find -type f` in the sandbox does not match one, so a pushed symlink is absent from every listing that comes back — which is how a deletion is recognised. This repo's `.cursor/rules/` symlink was deleted exactly that way. `transmittableSet` uses `lstat` and sends regular files only; a symlinked file is invisible in the sandbox, which is a limitation rather than a defect.
- **`COPYFILE_DISABLE=1` on every `tar`.** macOS bsdtar writes an AppleDouble `._name` member per file with xattrs; GNU tar in the sandbox extracts them as ordinary files, which then look like files a command created. One run put 217 of them in the repo.

Measured, so worth not re-discovering: `bun` is **not** in E2B's base template (node, npm, python3, git, gcc, make, curl, tar are), so a `bun.lock` in the pushed tree triggers a one-off install. A command round trip is ~300ms. `169.254.169.254` is reachable but is Firecracker's own metadata service, not a cloud credential endpoint; `10.0.0.1` and `192.168.1.1` are not reachable.

`packages/tests/sandbox/e2b.integration.test.ts` is the live proof, and it needs `WOOPCODE_E2B_TESTS=1` as well as a key. Gating on the key alone is not enough: Bun loads `.env`, so everyone working here has one, and the suite would boot a VM before every commit. Guarded by a runtime check inside each body rather than `.skip`, which `verify.ts` flags. Everything else in `packages/tests/sandbox/` runs against a fake client in CI.

User state (config, conversation, execution log) lives in `~/.config/woopcode/` (`%LOCALAPPDATA%\woopcode\` on Windows), never in the repo.

## Conventions

Skills for the procedures that are multi-step and easy to half-do live in
`.claude/skills/` — adding a tool, changing what the prompt carries, writing a
test, and touching approval. Each ends in the command that checks it. Read the
matching one before starting that kind of work.

Before you do any work, mention how you could verify that work — the test, command, or observation that would show it actually worked. If a change can't be verified, say so before making it.

### Never call work finished without checking the tree as it stands now

"Done", "shipped" and "verified" are claims about the working tree at the moment
you say them, not a run from earlier. Before any of those words, run this and
quote what it printed:

```bash
bun install                # if package.json or bun.lock moved since your last install
bun run verify --all       # tsc + bun test + docs; the whole gate whatever changed
```

Three ways a green run goes stale underneath a claim, all of which happened here:

- **`node_modules` is stale** — a dependency landed on `main`, never installed
  locally, and every import of it fails with `Cannot find package '<x>'`. It went
  red across twenty-four tests, reading exactly like a code break.
- **`main` moved after your branch went green** — two branches that each pass CI
  can merge into a red `main`, git finding no textual conflict while one silently
  fails to honour a parameter the other added. After any fetch, merge or rebase,
  or whenever `origin/main` is ahead, re-run the gate on the merged tree.
- **A bare `bun run verify` on a staged tree** reports a pass it did not run; see Commands.

**But a green suite is not a review.** It says the cases you thought of hold and
nothing about the rest — and "I checked everything" is a claim about the rest.
The sessions work went green on every gate and sweep; reading the diff afterwards
found seven defects, one of which wrote into the session `--fork-session` exists
to protect. Walk the diff and ask, per changed file:

- **Every default argument** is an assumption about the caller (`forkSession`
  defaulted to the current project; sessions elsewhere silently failed to fork).
- **Every `?? fallback` on a failure path** — what does it *do* when it fires?
  (`fork() ?? original` turned a failed copy into a write to the original.)
- **Every read-modify-write** — two windows, two processes (the index lost a row
  and the session stopped being listed at all).
- **Every counter or flag in a loop** — per-iteration or cumulative? (Prune's was
  cumulative across projects.)
- **Every write recording that something happened** — does it create state where
  the feature promises none? (`pruneIfDue` created the directory lazy creation
  exists to avoid.)
- **Every optional CLI value** — what does the bare flag do? (`--resume` was
  indistinguishable from `--continue`.)
- **Every empty string, empty array and zero** reaching a renderer.
- **Every caller you did not write** — a new signature is only as sound as the
  stubs standing in for it elsewhere.

Then about the checking itself:

- **A regression test that has never failed proves nothing.** Revert the fix,
  watch it go red, restore it — and confirm the revert actually applied. Twice a
  mutation silently did not match, the suite stayed green, and the claim was void.
- **Name what you did not check.** Interactive input, live providers and other
  processes are outside the suite's reach. Say so rather than letting a green run
  imply them: a verification reported but not run stops anyone else looking.

Conventional commits (`feat(tools):`, `fix(runtime):`, …), TypeScript strict mode, small focused functions.

Bun over Node throughout — the full rule is in `AGENTS.md` and `.cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc`:

- `bun <file>`, `bun test`, `bun install`, `bun build`, `bunx` — never node/npm/pnpm/vite/jest/webpack.
- `Bun.file` over `node:fs` read/write, `Bun.$` over execa, built-in `WebSocket`, `Bun.serve()` over express, `bun:sqlite` over better-sqlite3.
- The site uses `Bun.serve()` with HTML imports; no bundler config.
