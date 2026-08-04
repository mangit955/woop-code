---
title: Plan mode
type: guide
summary: Let the agent investigate and propose without letting it change anything, and why a read-only session still needs the terminal.
prerequisites:
  - /docs/getting-started/first-session
related:
  - /docs/guides/approval-modes
  - /docs/reference/keyboard
since: 0.7.0
---

# Plan mode

A session is in one of two modes. **Build** is the normal one: the agent reads,
runs commands, and proposes edits you approve on a diff. **Plan** is the same
session with one promise added — nothing it does can change the repository.

Press <kbd>Tab</kbd> to switch. The composer changes colour and the caret
follows it, so you can see which mode you are in without checking anywhere else.

Use it when you want the answer before the change: *how would you restructure
this?*, *what breaks if I rename that?*, *where does this get called from?* The
agent looks around properly — reads files, greps, runs the test suite — and
replies with a proposal in prose instead of starting work.

## What still runs

Reading is untouched. So is the terminal, which is the part people expect to be
switched off:

| Still available | Refused |
| --- | --- |
| Reading and searching files | Editing a file |
| Listing and globbing | Creating or overwriting a file |
| Running the tests, the build, the type checker | `sed -i`, `cat > file`, a script that opens a file for writing |
| `git log`, `git diff`, `git status` | `git commit`, `git checkout`, anything that moves the tree |
| Asking you a question | Any tool whose effect has not been classified |

The terminal has to stay: inspection is most of what planning is, and a mode
that cannot run `bun test` cannot tell you whether the thing you are asking
about currently works.

That is also why the refusal is judged on the **command**, not on the tool. A
filtered tool list cannot see arguments, so `run_terminal` reaching the disk
through a redirect is caught when the call is made rather than when the list is
built.

:::note
A tool Woopcode does not recognise is refused, not allowed. A mode whose whole
promise is that nothing changes has to fail closed, so a newly added tool is
withheld until someone records what it does.
:::

## What the agent is told

A refused write comes back to the agent as a result, not an error, so the turn
keeps going:

```terminal
Not applied: edit_file was refused because this session is in plan mode.
Nothing was written and the workspace is unchanged. Do not attempt another way
of writing it — every writing tool and any shell command that edits a file is
refused while planning, including redirects and sed -i. Finish investigating
and reply with the plan in prose: what you would change, in which files, and
how it would be verified.
```

It cannot report the change as applied, and it cannot route around the refusal,
so it finishes the plan instead of losing the turn.

## Leaving it

Press <kbd>Tab</kbd> again. There is deliberately no tool for it — the mode
belongs to the person at the keyboard, and an agent that could leave plan mode
would not be much of a guarantee.

Switching mid-turn takes effect on the **next** turn. The mode is read once when
a turn starts, so a turn already running finishes under the rules it began with
rather than changing halfway.

:::warning
Plan mode is not saved. Every session starts in Build, including the one you
open right after quitting a planning session.

This is deliberate. A mode that survived a restart would silently swallow the
first edit of your next session, and you would be left wondering why the agent
said it changed a file that never changed.
:::

## Plan mode and approval modes

They solve different halves of the same problem and both apply at once.

[Approval modes](/docs/guides/approval-modes) decide **what you get asked
about**. Plan mode decides **what is possible at all**. Even in `full-auto`,
which asks about nothing, a planning session still writes nothing — the refusal
happens before the approval question is ever reached.

## See also

- [Approval modes](/docs/guides/approval-modes) — the other half of the control
- [Keyboard](/docs/reference/keyboard) — every binding, including <kbd>Tab</kbd>
