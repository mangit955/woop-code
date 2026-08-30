---
title: Finish gates for an unattended turn
type: concept
summary: Why a turn that stops early is asked to prove the task's requirements, why the task statement is pinned into the window, and which alternatives were rejected.
prerequisites: []
related:
  - /docs/adr/0001-wall-clock-budget-for-the-agent-loop
since: 1.1.0
---

# Finish gates for an unattended turn

Status: accepted

A turn ends when the model responds without calling a tool. Until now one thing
could overrule that: a turn that had changed files and run nothing to check
them was asked, once, to verify. That gate fires on evidence the loop can see.
The failure it cannot see is a turn that verified something thoroughly, and
verified the wrong thing.

## The measurement

Two of the three failed trials in the `jobs/tb2-post-1.1` run ended that way,
early and confident, with most of both budgets unspent.

| task | stopped at | of ceiling | wall used | what it did |
| --- | --- | --- | --- | --- |
| overfull-hbox | iteration 59 | 200 | 26% | ran its chosen check three times, declared success |
| video-processing | iteration 83 | 200 | 7% | confident, wrong |

`overfull-hbox` is the instructive one. It ran `pdflatex` and a search for
overfull boxes three times over, so the unverified-edits gate had nothing to
say — the edits *were* checked. The task also constrained which wording was
permitted, and nothing it ran tested that. CLAUDE.md already recorded the
pattern from an earlier run: two trials that reported success with accurate
self-verification still scored zero, because they verified the wrong property.

These are the cheapest points on the board. The agent had roughly 70% of both
budgets left and chose to stop.

## What was decided, and the alternatives

**A second finish gate, asked once, headless only.** When an unattended turn
responds with no tool calls and has budget left to act, the loop injects one
user message: enumerate every requirement the task states, including
constraints on what is *not* allowed, and quote the command output that proves
each one — with recollection explicitly refused as evidence.

Interactive turns are excluded because a person is reading the answer and can
correct it for the cost of one sentence, and because a conversational turn has
no requirements to enumerate. The loop learns this from an explicit
`unattended` option rather than by inferring it from a missing optional
callback, which would have handed the behaviour to every embedder that happened
not to pass one.

Rejected: **strengthening the system prompt.** Free, and it is where the
instruction to verify already lives — which is the argument against it. The
model is told to verify today and did, three times, against the wrong property.
A prompt is read once at the start of a turn that goes on to run for hundreds
of iterations; a loop mechanic fires at the moment the mistake is being made.

Rejected: **firing only on turns that wrote something.** Narrower, but it
misses a task whose deliverable is a written answer, and the observed failure is
independent of whether files changed.

**The gate needs ten steps, and no wind-down warning outstanding.** Ten is twice
the wind-down threshold. The gate asks for work, and inside that zone the loop
is telling the model the opposite — finish what you started, begin nothing new.
The flag is read as well as the count because the count is derived from a
measured rate that moves: it can recover past the floor while the model is still
under a warning issued earlier.

**Both gates answer with one message.** They are cheap in round trips and
expensive in window: every message the loop pushes costs one of the six
conversation turns the window keeps, and losing the window is what this gate
exists to correct.

**The task statement is pinned into the window.** The gate tells the model to go
back to the task statement above, and that has to be true. The window counts
user messages, and the loop pushes user messages of its own — the wind-down
warning, the finish gates, a truncated-stream resume — so six of them and the
question being worked on has left the request. The loop captures the
turn-initiating message when it is entered and `recentMessages` carries it back
in when the window has moved past it.

This makes the turn ceiling a bound on the *tail* rather than on the window: a
pinned request carries one conversation turn more than `MAX_TURNS` names, and
never two. That is the only exception in a budget every other context decision
treats as absolute, so it is written down here as well as at `recentMessages` —
the extra message is one prompt, carrying no tool results, and it is prepended
only when it has genuinely fallen out of the tail.

Rejected: **quoting the task into the gate's message instead.** Self-contained
and needs no context change, but a long turn still argues from a question it
cannot see. Rejected: **pinning `messages[0]`.** Wrong for an interactive
session, where the first message is usually a greeting, and wrong under
`--resume`, where it came off disk after trimming.

**The duplicate threshold is cleared when the gate fires.** The two collide head
on: the check a turn most needs to re-run is usually the one it has already run
twice, where the loop answers that the result is already in the conversation —
pointing at output the window dropped long ago. An amnesty rather than an
exemption, since the gate fires once and only above the step floor.

The reset is wholesale — every previously exhausted call may run again, not only
the one the gate is asking about — so what bounds it is that it happens once and
that suppression resumes immediately: the threshold counts again from zero, and
a third identical call after the gate is refused exactly as it would have been
before. A narrower amnesty, scoped to calls that classified as verification,
was considered and rejected: `TurnState` does not record a classification per
key, and adding one buys a distinction the step floor already pays for.

## How it will be judged

`TurnSummary` gains `requirementReminders` and `requirementGateActedOn`, both
written to `run_end` in the events JSONL. They exist to separate three outcomes
that a score alone collapses into one: the gate never fired, the gate fired and
the model went and ran commands, and the gate fired and the model answered in
prose from memory. The last is this mechanism's likeliest failure, and without
the flag it is invisible.

`requirementGateActedOn` compares tool executions against a snapshot taken as
the gate fires. That reads as "afterwards" rather than "at some point" because
the count never decreases and the gate fires from a response that called no
tool, so nothing can move it in between.

Every mechanism here was proved by reverting it and watching its test go red,
because a regression test that has never failed proves nothing. Each revert was
confirmed applied before the suite ran:

| reverted | what went red |
| --- | --- |
| the clock guard on the verification gate | `WallBudgetExhaustedError` in place of the finished answer |
| the pin | the task absent from every request after the sixth injection |
| the requirement gate's `unattended` condition | seven tests, while the three negative ones stayed green |
| the duplicate amnesty | two executions of the repeated check instead of three |
| the composed status line | the merged notice naming only the verification gate |
| the trial metadata keys | `KeyError` in the harness tests |

The replay harness cannot speak to any of this. Its recordings hold one
conversation turn each — the loop's injected messages were never written to the
event log — so the pin never fires there and the baseline is unchanged by
construction. What settles it is the benchmark: `overfull-hbox` and
`video-processing` first, then the five-task job to check the three passing
tasks did not regress.
