# WoopCode × Harbor

Benchmark the WoopCode CLI on Harbor datasets such as `terminal-bench-2`.

```bash
PYTHONPATH=. harbor run -d terminal-bench/terminal-bench-2 -a harbor_woopcode:WoopCode -m google/gemini-3.5-flash-lite --ak source_dir=$(pwd)
```

---

## First: `harbor adapter` is not how agents are integrated

Harbor's `adapter init` / `adapter review` commands manage **dataset adapters** —
code that converts a third-party benchmark (SWE-bench, MLEBench) into Harbor
tasks. The scaffold `harbor adapter init` produces contains a `task-template/`,
a `parity_experiment.json`, and an `adapter.py` whose job is to emit tasks. Its
`--name` flag is documented as "Vanilla benchmark name (e.g., SWE-bench)".

Agents are a separate subsystem: `harbor/agents/`, resolved through
`AgentFactory` in `harbor/agents/factory.py`. There is no review command for
them, and `harbor adapter review` cannot validate an agent — it checks for
benchmark-adapter files that an agent does not and should not have.

So WoopCode is integrated as an **agent**, not an adapter. Everything below
follows the pattern used by Harbor's own `claude_code`, `opencode`, and
`gemini_cli` agents.

## Choosing an integration pattern

Harbor supports several ways to plug in an agent. They are not interchangeable
for a benchmark.

| Pattern | What Harbor drives | Fit for WoopCode |
| --- | --- | --- |
| **Installed agent** (`BaseInstalledAgent`) | Installs a CLI in the container, runs it once per task, reads its logs | **Chosen.** WoopCode is exactly this: a local CLI that owns its own loop |
| ACP (`-a acp:<agent>`) | JSON-RPC session over the Agent Client Protocol | Would require WoopCode to implement an ACP server — a large change that measures the same loop |
| Model-driven (`terminus-2`, `computer-1`) | Harbor runs the loop and calls the model itself | **Wrong for this goal.** It would benchmark *Harbor's* agent loop with a Gemini model, not WoopCode |

The distinction that matters: benchmarking WoopCode means benchmarking
WoopCode's own planning, tool selection, and recovery. Only the installed-agent
pattern leaves that loop intact — Harbor stays outside it and observes results.

## Architecture

```
harbor run
   └── WoopCode (harbor_woopcode/agent.py)
         ├── install()  → Bun + woopcode CLI into the task container
         ├── run()      → woopcode -p "<instruction>" -m <model> --events <log>
         └── populate_context_post_run() → JSONL events → ATIF trajectory.json
```

### Key decisions

**Subprocess, not an API.** WoopCode's value in a benchmark is its agentic
behaviour. Invoking it as a CLI keeps the tool loop, approval logic, and
recovery behaviour under test. Exposing it as an OpenAI-compatible endpoint
would reduce it to a model proxy and measure nothing about the agent.

**Headless single-turn mode.** `woopcode -p` runs one turn without the TUI and
exits with a status code. A terminal UI cannot run under Harbor: there is no
TTY, and Ink would render escape sequences into a pipe.

**Credentials via environment, never a config file.** Keys are forwarded from
the host into the container's process environment. Nothing is written to the
image or to the trial's log mount, so no secret is persisted with results.

**Structured event log, separate from stdout.** Stdout stays human-readable;
`--events` writes JSONL that converts cleanly to ATIF. Events are flushed as
they occur, so a run killed at the agent timeout still yields a partial
trajectory instead of an empty file.

**Exit code 2 means "out of iterations", and is not an error.** Harbor counts a
raised exception as an infrastructure failure and drops the trial from the
mean — which would silently *inflate* the reported score. An agent that ran out
of budget did run; it should be scored 0 by the verifier, not excluded. The
agent maps exit 2 to success and lets the verifier decide.

**Bun is cached on the host, not downloaded per trial.** Every trial gets a
fresh container, so installing Bun from the network each time would re-fetch
~36MB per task — 89 times for a full terminal-bench-2 run. On the machine this
was developed on that download took ~2 minutes and failed partway through more
than once, blowing the 360s setup budget and failing trials before the agent
ran. The release zip is fetched once into `~/.cache/harbor-woopcode/` and pushed
into each container; the official installer remains as a fallback, so a cache
miss degrades speed rather than correctness.

**Token and cost metrics are left unset.** WoopCode's provider client does not
surface usage. Reporting zero would be worse than reporting nothing, because
Harbor's aggregates cannot tell "free" from "unknown".

**`SUPPORTS_RESUME = False`.** WoopCode's headless mode has no
session-continuation flag. Declaring resume support would make Harbor silently
drop context between steps of a multi-step task.

## Changes made to the WoopCode CLI

All are generally useful, not Harbor-specific:

| Change | File | Why |
| --- | --- | --- |
| Credentials from the environment | `config/envCredentials.ts` | A fresh container has no config file and no way to run the wizard |
| Fail fast without a TTY | `onboarding/index.ts` | The Ink wizard would otherwise block until the harness timeout — a hung agent instead of a clear error |
| `-m, --model` | `commands/agent.tsx`, `cli.ts` | Lets a caller select a model per run without mutating stored config |
| `--events <path>` | `runtime/eventLog.ts` | Machine-readable trajectory, separate from human stdout |
| `WOOPCODE_MAX_ITERATIONS` | `config/runtime.ts` | The interactive default of 20 is far too low for a benchmark task; it was the binding constraint in early runs |
| Exit code 2 for budget exhaustion | `commands/agent.tsx` | Distinguishes "didn't finish" from "broke" |
| Clean exit on config failure | `cli.ts` | A one-line message and exit 1 instead of an unhandled-rejection stack trace |

## Configuration

Pass with `--ak key=value`, or under `kwargs:` in `job.yaml`.

| Kwarg | Default | Purpose |
| --- | --- | --- |
| `source_dir` | — | Install from a local checkout instead of npm. Required until the CLI changes above are published |
| `version` | `latest` | npm version to install. Pin for reproducible numbers |
| `max_iterations` | `200` | Loop budget per task |
| `auto_approve` | `True` | Must stay on; there is no human to approve edits |

## Running

```bash
# Structural check: Harbor can resolve and construct the agent
PYTHONPATH=. python3 -m pytest harbor_woopcode/test_agent.py -q
```

```bash
# Benchmark against the local checkout
export GEMINI_API_KEY=...
PYTHONPATH=. harbor run -d terminal-bench/terminal-bench-2 -a harbor_woopcode:WoopCode -m google/gemini-3.5-flash-lite --ak source_dir=$(pwd) -l 5 --agent-setup-timeout-multiplier 2 --max-retries 2 --retry-include ApiRateLimitError
```

### Two flags worth knowing about

**`--agent-setup-timeout-multiplier 2`.** Harbor allows 360s for agent setup.
Installing Bun (a ~40MB download) plus dependencies fits on a warm host but not
reliably on a cold one, and overrunning surfaces as `AgentSetupTimeoutError`
before the agent ever runs. Setup is already trimmed — the apt step is skipped
when `curl` and `unzip` are present, and the Bun download is retried with a
bounded budget — but on a slow network the extra headroom is what keeps an
infrastructure flake from being scored as an agent failure.

**`--max-retries 2 --retry-include ApiRateLimitError`.** Gemini's free tier
rate-limits quickly at any real concurrency; in testing, four concurrent trials
exhausted quota and every trial was dropped from the mean. Retrying only the
rate-limit class keeps genuine failures scored while absorbing quota blips. Use
`-n 1` on a free-tier key.

```bash
# Or from the checked-in job config
PYTHONPATH=. harbor run -c harbor_woopcode/job.yaml
```

### Verifying WoopCode ran, and not the oracle

The oracle copies a known-good solution from `/solution` and always scores 1.0.
Any of these distinguishes a real run:

```bash
harbor run -c harbor_woopcode/job.yaml --print-config
```

`agents[0].name` must read `harbor_woopcode:WoopCode`.

```bash
cat jobs/<job-name>/<trial>/agent/woopcode.txt
```

The oracle never produces this file. It contains WoopCode's own tool trace
(`• read_file`, `• create_file`).

```bash
python3 -c "import json;print(json.load(open('jobs/<job>/<trial>/agent/trajectory.json'))['agent'])"
```

Reports `{"name": "woopcode", "version": ..., "model_name": ...}`.

A run that is *actually* the oracle shows `agent/solve.sh` output, a reward of
exactly 1.0 on every task, and no `woopcode*` files.
