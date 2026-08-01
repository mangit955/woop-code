---
title: Slash commands
type: reference
summary: The commands you type inside a session, grouped by what they act on.
prerequisites: []
related:
  - /docs/reference/cli
  - /docs/guides/approval-modes
since: 0.6.0
---

# Slash commands

Type `/` in a session to see the list. `/help` prints it in full.

## Session

{{slash-commands-table:session}}

`/new` clears the conversation and the saved history for this repository. There
is no undo — see [Sessions & history](/docs/guides/sessions-and-history) for
what is stored and where.

## Configuration

{{slash-commands-table:configuration}}

`/provider`, `/model`, and `/approval` open a picker rather than taking an
argument. The choice is saved immediately and survives restarts.

`/login` and `/logout` change the stored key. The running session keeps using
the client it started with until the provider is switched, so a `/login` for a
different provider does not silently redirect the turn you are in.

## Workspace

{{slash-commands-table:workspace}}

`/workspace` reports the directory Woopcode is operating in, the current git
branch, and a file count. It is the fastest way to confirm the agent is looking
at the project you think it is.

## Every command

{{slash-commands-table}}

## See also

- [CLI](/docs/reference/cli) — the commands you type in your shell
- [Approval modes](/docs/guides/approval-modes) — what `/approval` changes
- [Keyboard](/docs/reference/keyboard) — keys, not commands
