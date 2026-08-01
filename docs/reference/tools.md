---
title: Tools
type: reference
summary: Every tool the agent can call, and which of them can change your files.
prerequisites: []
related:
  - /docs/guides/approval-modes
  - /docs/reference/tools/read-file
since: 0.6.0
---

# Tools

Woopcode ships {{counts.tools}} tools. The agent chooses which to call; you
control what happens when it calls one that writes.

## Which of these can change my files

These, and only these. Everything else either reads the repository, runs a
command, or asks you a question.

{{tools-table:write}}

Every one of those pauses on a unified diff and waits. No approval mode turns
that off — see [Reviewing diffs](/docs/guides/reviewing-diffs).

## Explore and read

These never change anything and never ask.

{{tools-table:read}}

## Shell

{{tools-table:shell}}

Gated by the approval mode, not by a diff. The default runs reads and tests
without asking and stops before anything that writes.

:::warning
`run_terminal` and `run_tests` are for short, non-interactive commands. They do
not start servers or watch processes, and a command that waits for input will
sit there until you cancel the turn.
:::

## Ask

{{tools-table:ask}}

The turn stops and waits for your answer, then continues with it.

## Every tool

{{tools-table}}

## How a tool call goes wrong

Tool failures are returned to the agent rather than ending the turn, so it can
correct itself and try again. Three limits shape what it sees:

| Limit | Value | Effect |
| --- | --- | --- |
| Tool result size | 4,000 characters | Longer results are truncated with a notice |
| Identical calls per turn | 4 | The fifth is skipped and the agent told why |
| Iterations per turn | 20 | The turn ends; a warning is issued at 15 |

The duplicate check compares the tool name and its exact arguments. The first
four identical calls run normally; from the fifth on, the agent gets a skip
notice instead of the result:

```terminal
Skipped duplicate read_file call. The result for these exact arguments is
already in the conversation; use it and continue with a different action.
```

That is what stops a turn from looping on the same lookup. Reading the same
file twice is fine and happens often.

## See also

- [`read_file`](/docs/reference/tools/read-file) — one tool in full
- [Approval modes](/docs/guides/approval-modes) — what gates the shell tools
- [Adding a tool](/docs/architecture/adding-a-tool) — the registry these come
  from
