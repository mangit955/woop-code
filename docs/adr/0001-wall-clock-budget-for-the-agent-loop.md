---
title: Wall-clock budget for the agent loop
type: concept
summary: Why the loop measures a second budget in seconds, what the reserve holds back, and which alternatives were rejected.
prerequisites: []
related:
  - /docs/reference/configuration
since: 1.1.0
---

# Wall-clock budget for the agent loop

Status: accepted

The loop has only ever measured its budget in iterations. Harbor enforces a
wall clock. Running the checked-in five-task config with
`WOOPCODE_MAX_ITERATIONS=200`, every trial finished having spent between 2% and
23% of the time it was given, and `make-mips-interpreter` was killed by its own
200th iteration at 406s of 1800 — mid-work, with `exception_info: null` proving
Harbor's timeout never fired. So the loop gets a second budget,
`WOOPCODE_MAX_WALL_SEC`, and stops on whichever of the two binds first.

## The measurement

Per-task agent timeouts come from each task package's `task.toml`
(`~/.cache/harbor/tasks/packages/terminal-bench/<task>/<digest>/task.toml`).
Against the `jobs/tb2-post-1.1` run:

| task | timeout | wall used | unused | iterations | what stopped it |
| --- | --- | --- | --- | --- | --- |
| build-pov-ray | 12000s | 287s | 98% | 79 | model chose to |
| circuit-fibsqrt | 3600s | 400s | 89% | 165 | model chose to |
| make-mips-interpreter | 1800s | 406s | **77%** | **200** | **our ceiling** |
| overfull-hbox | 750s | 192s | 74% | 59 | model chose to |
| video-processing | 3600s | 261s | 93% | 83 | model chose to |

CLAUDE.md's benchmarking section records the opposite rule — *"Wall clock is the
binding budget, not iterations"* — and a future reader will find it and assume
this change is a mistake. That claim was measured on `overfull-hbox`, which has
the shortest timeout in the set by 2.4×. It does not generalise to the other
four, and correcting it is part of this work.

Iteration rate, measured: `make-mips-interpreter` averaged 2.03s of wall per
iteration (1.77s of it provider time), so its 1800s had room for roughly 885.

## What was decided, and the alternatives

**Both budgets stand; neither replaces the other.** With the wall bounding
spend, the iteration ceiling reverts to the role `loop.ts` already claims for it
— a guard against a pathological loop with nobody watching — and `job.yaml`'s
`max_iterations` goes 200 → 1000 so it stops binding first.

Rejected: **raising `max_iterations` alone.** Zero code, immediately testable,
but the loop still cannot see a clock, so on `overfull-hbox`'s 750s a slow run
gets hard-killed by Harbor mid-work instead of winding down. Also rejected:
**per-task iteration budgets** derived from each timeout ÷ measured rate — honest
to the data, but it is hand-tuning benchmark config per task, which is fragile
and overfits.

**The operator passes the whole budget; the loop subtracts its own reserve.**
`agent.py` forwards Harbor's `timeout_sec` verbatim, so a published number traces
back to `task.toml` with no arithmetic in between, and the safety margin stays
one constant in one repository. Rejected: having the caller send a pre-reduced
figure (`timeout_sec * 0.9`), which splits the reserve across two repos and
scales a fixed wind-down cost proportionally, giving a 750s task the same
fraction as a 12000s one.

**Tool timeouts are clamped to the remaining budget.** Without it the deadline
is advisory: `run_terminal` defaults to 300s and the model may ask for more, so
one command started just inside the budget outlives it by minutes — on
`overfull-hbox`, a single default-timeout call is 40% of the entire budget.
`run_terminal`, `run_tests` and `repl` clamp; `process_start` deliberately does
not, because a background process does not hold the loop and so cannot overshoot
the deadline. The clamp is read after approval rather than at the top of
`execute`, since the clock runs while a human decides.

**A clamped kill is explained by the clock, not by the timeout.** The standing
advice for a timeout is to run it again with a larger one, which is exactly
wrong when the budget rather than the number ended the call — the model would
spend its last seconds reaching the same end. Rejected: leaving the existing
messages and relying on the wind-down warning to have set the context, which
puts two paragraphs an unknown number of tool calls apart and asks the model to
connect them.

**The deadline lives in module state (`runtime/deadline.ts`), not on
`Tool.execute`.** `runtime/sandbox/registry.ts` argues this case in its own
docstring for the same shape: three tools need it, and threading it through
would change the `Tool` interface in `config/types.ts` and every tool signature.

**`onBudgetExhausted` is not consulted when the wall deadline binds.** The
iteration ceiling can afford to ask because iterations do not tick while a human
thinks. A clock does — and the only path with a handler is the interactive one,
which will not have the variable set.

**`WallBudgetExhaustedError` is a sibling of `IterationBudgetExhaustedError`
under a shared `BudgetExhaustedError`, and both exit 2.** The exit contract in
`commands/agent.tsx` already means "worked, did not finish, judge the result
rather than treat this as a crash", which is exactly what a deadline produces,
and `agent.py` already maps 2 to success. A distinct exit code 3 was rejected:
until `agent.py` was updated to match, Harbor would book those trials as
exceptions and drop them from the mean, overstating measured accuracy.

**The wind-down converts time into steps rather than warning separately.**
Remaining time ÷ the turn's own mean wall-per-iteration gives a step count, and
the existing `REMAINING_ITERATIONS_WARNING = 5` then serves both budgets through
one message and one flag. A constant expressed in seconds was rejected as the
wrong shape across this task set — 120s is 16% of `overfull-hbox`'s budget and
1% of `build-pov-ray`'s.

## Consequences

- `WOOPCODE_MAX_WALL_SEC` and the exit-code behaviour become a contract with
  `harbor_woopcode/agent.py`. Changing either means changing both.
- The wind-down flag replaces an equality test (`iterations === budget - 5`)
  that silently never fired when the ceiling was below five.
- This fixes a loop that ends early. It makes **no claim** about benchmark
  reward: with five tasks at one trial each, and three failures with three
  unrelated causes, there is no power to attribute a score change to it. The
  claim to verify is narrower — that the loop no longer kills itself with
  budget in hand.
