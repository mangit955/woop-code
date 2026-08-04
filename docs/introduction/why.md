---
title: Why use it
type: concept
summary: What Woopcode is good at, what it is bad at, and when a different tool is the right answer.
prerequisites: []
related:
  - /docs/introduction/what-is-woopcode
  - /docs/guides/approval-modes
since: 0.6.0
---

# Why use it

## What it is good at

**Questions about a codebase you did not write.** "How is authentication
structured here", "where does this config get read", "what calls this
function". The agent searches, reads, and answers, and you can see which files
it based the answer on.

**Small, specific changes.** Add validation to an endpoint. Fix the bug behind
a failing test. Write the docstring. Changes where you can describe the outcome
in a sentence and check the diff in ten seconds.

**Work you want to watch.** Because everything streams and every write pauses,
Woopcode fits the case where you want the speed of an agent without giving up
the review.

## What it is bad at

**Large refactors across many files.** A turn works in stretches of 40 steps and
stops to ask before taking another, so a broad sweeping change means answering
that question repeatedly rather than handing the work over once.

**Long autonomous runs.** There is no plan-then-execute mode and no background
work. If you want to hand over a task and come back in an hour, this is the
wrong tool.

**Anything needing a live process.** The shell tools are for short,
non-interactive commands. They do not start servers, run watch processes, or
hold anything open.

**Provider choice.** Google Gemini is the only implemented provider today.

## How it compares

The difference worth naming is *when the review happens*. Many agents write
first and let you inspect the result in git afterwards. Woopcode puts the
review before the write: the diff is shown, the turn waits, and nothing lands
until you press a key.

That is slower per edit. It is faster when the agent is wrong, which is the
case that actually costs you time.

## When to reach for something else

- The change spans dozens of files → do it yourself, or break it up
- You want it to run unattended → use `--prompt` in CI with
  `--no-auto-approve`, and accept that it can only read
- You need a provider other than Gemini → not yet

## Next

- [How a turn works](/docs/introduction/how-a-turn-works)
- [Your first session](/docs/getting-started/first-session)

