---
title: How a turn works
type: concept
summary: What happens between pressing Enter and getting an answer, including the limits that end a turn.
prerequisites: []
related:
  - /docs/reference/tools
  - /docs/guides/approval-modes
since: 0.6.0
---

# How a turn works

A turn is one prompt and everything Woopcode does in response to it.

```text
prompt → repository context → model → tool calls → approval → result
                                ↑                      │
                                └──────────────────────┘
                                     up to 20 times
```

## 1. Context is assembled

Before the model sees anything, Woopcode builds a short description of the
repository: a summary of your package metadata, the README, and the top-level
directory structure. Each piece is capped, and the whole thing is capped again
at 8,000 characters.

It deliberately does not include a file listing. That can be enormous, and the
agent has tools to find files when it needs them. The context is a starting
point, not a snapshot.

Only the most recent six turns of conversation are sent, which is what keeps a
long session from growing without limit.

## 2. The model responds

The response streams. Text appears as it is generated, and any tool calls the
model wants to make arrive alongside it.

## 3. Tools run

Each tool call is executed and its result handed back. What happens next
depends on the tool:

- **Reading tools** run immediately and never interrupt you.
- **Writing tools** stop and show a diff. Nothing is written until you approve.
- **Shell tools** are checked against your [approval
  mode](/docs/guides/approval-modes).
- **`ask_user`** stops the turn and waits for your answer.

Results are capped at 4,000 characters before being returned to the model;
longer output is truncated with a notice so the agent knows there is more.

## 4. The loop repeats

The result goes back to the model, which decides whether it has enough. That
cycle — respond, call tools, feed results back — repeats until the model
produces an answer without asking for more tools.

## What ends a turn

| Limit | Value | What happens |
| --- | --- | --- |
| Iterations | 20 | The turn stops; a warning is issued at 15 |
| Identical calls per turn | 4 | The fifth is skipped and the agent told why |
| Tool result | 4,000 characters | Truncated with a notice |
| Conversation sent | 6 turns | Older turns are not sent to the model |

The duplicate check compares the tool name and its exact arguments: the first
four identical calls run, and from the fifth on the agent gets a skip notice
instead of the result. That is what stops a turn looping on the same lookup. Woopcode also nudges the
agent toward finishing once six tools have run in a turn — exploring is useful
right up until it becomes a substitute for doing the work.

## Cancelling

<kbd>Ctrl</kbd><kbd>C</kbd> cancels a running turn, including one parked on an
approval dialog. See [Keyboard](/docs/reference/keyboard).

## Afterwards

The conversation is saved, globally rather than per repository — restarting
Woopcode anywhere resumes from it. See
[Sessions & history](/docs/guides/sessions-and-history).

## Next

- [Tools](/docs/reference/tools) — what the agent can call
- [Approval modes](/docs/guides/approval-modes) — what runs without asking
