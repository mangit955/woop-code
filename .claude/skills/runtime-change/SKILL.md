---
name: runtime-change
description: Use when changing anything that decides what goes into the prompt — config/runtime.ts, runtime/compaction.ts, runtime/executionLog.ts, config/systemPrompt.ts, or buildRepositoryContext and recentMessages in config/config.ts. Requires a replay baseline captured before the edit and compared after, because the harness that measures this is opt-in and the gate does not know it exists. Triggers on "context window", "compaction", "token budget", "system prompt", "the agent is sending too much", or any edit to the agent loop.
---

# Changing what the prompt carries

`packages/tests/replay/cli.ts` measures prompt assembly across a corpus of
checked-in recordings in `packages/tests/fixtures/replay`. It produces the same
numbers every run, so a context change can be compared against a baseline without
paying for a live benchmark. Nothing forces you to run it. Run it.

## The procedure

**Capture the baseline before you edit.** Once the working tree has changed, the
"before" number is gone unless you stashed it.

```bash
bun run replay:baseline > /tmp/replay-before.txt
```

Make the change, then:

```bash
bun run replay:baseline > /tmp/replay-after.txt
diff /tmp/replay-before.txt /tmp/replay-after.txt
```

Read two things in the diff:

- **Peak prompt characters, per fixture.** `cli.ts` calls this the figure a
  windowing change has to move. If it did not move, the change did not do what
  you think it did.
- **The totals line.** Corpus-wide characters as recorded against characters
  under the new assembly, with the percentage.

Some of this can be measured without editing anything: the budget knobs are
environment variables, so

```bash
WOOPCODE_TOOL_HISTORY_BUDGET=20000 bun run replay:baseline > /tmp/replay-after.txt
```

answers "what would a tighter budget cost" against a clean tree. Reach for a
code change only once you know the shape of the answer.

A single fixture is not representative — the summary prints the spread (mean,
median, min, max) across the corpus for exactly that reason. Judge on the spread.

**State the delta in the commit body or the PR.** A context change with no number
attached is the thing this harness exists to prevent.

## The trap the harness prints about itself

Cache hit rates in that output are provider-observed for those recordings only.
A modified assembly cannot have its cache rate derived from them: implicit
caching depends on prefix stability, and rewriting earlier messages may *lower*
the hit rate rather than preserve it. Do not claim a caching improvement from
this harness. It cannot support one.

## What else this touches

- **Goldens.** `packages/tests/goldens/` holds recorded outputs so a formatting
  change has to be deliberate. If they move, say why in the commit message.
- **Segments are measured in characters, not tokens** — see `PromptSegments` in
  `config/types.ts`. Characters are exact and free; the provider's own token
  counts ride on the terminal stream event and are never estimated. Keep that
  split.
- **Defaults are conservative here.** Tool-history compaction is off by default
  on purpose. If a change makes something new happen by default, that is the part
  to justify, not the mechanism.

## Verify

```bash
bun test packages/tests/runtime/agentLoop.goldens.test.ts
bun test packages/tests/replay
bun run verify --all
```

Then the diff of the two baseline captures above, which is the only check that
speaks to whether the change achieved anything.
