---
title: Approval modes
type: guide
summary: How much Woopcode runs without asking, what every mode refuses to do anyway, and what full-auto gives up.
prerequisites:
  - /docs/getting-started/first-session
related:
  - /docs/reference/slash-commands
  - /docs/reference/tools
since: 0.6.0
---

# Approval modes

The approval mode decides which shell commands Woopcode runs on its own and
which ones stop and wait for you. Change it with `/approval`.

It governs shell commands only. Edits to existing files are gated separately and
always pause on a diff — no approval mode turns that off.

## One command, four modes

The agent wants to run `bun test`. Here is what happens in each mode, and
nothing else about the situation changes:

```terminal
  bun test

    always-ask       ⏸  asks
    auto-read-only   ▶  runs   ← default
    auto-workspace   ▶  runs
    full-auto        ▶  runs
```

Now the agent wants to run `rm -rf dist`:

```terminal
  rm -rf dist

    always-ask       ⏸  asks
    auto-read-only   ⏸  asks
    auto-workspace   ⏸  asks
    full-auto        ▶  runs — the directory is gone
```

The difference between the middle two modes is not visible in either example,
because both commands sit at the extremes. It shows up on something like
`git commit`: `auto-read-only` asks, `auto-workspace` does not.

## The modes

{{approval-modes-table}}

`/approval` with no argument prints the same list with the active mode marked:

```terminal title="woopcode — /approval"
Approval mode: Auto read-only

    always-ask — Confirm every shell command
  ✓ auto-read-only — Run reads and tests; ask before anything writes
    auto-workspace — Also write inside the workspace; ask to delete or touch the system
    full-auto (unsafe) — Run everything without asking — no protection
```

The setting is saved, so it survives restarts. Check it any time with `/status`.

## How a command gets classified

Every shell command is sorted into one of four risk levels before the mode is
consulted:

| Risk | Examples |
| --- | --- |
| Read-only | `ls`, `cat`, `grep`, `git log`, `git status`, `bun test` |
| Workspace write | `mkdir`, `touch`, `git add`, `git commit` |
| Destructive | `rm`, `git reset`, `git clean`, `git rebase` |
| System | `sudo`, `git push`, package installs, anything reaching the network |

Each mode declares the highest risk it will run unattended. Anything above that
line stops and asks.

Two properties of this classifier are worth knowing, because they explain most
surprising behaviour:

**An unrecognised command is treated as destructive.** If a command is not in
the tables, it is assumed to be dangerous rather than assumed to be safe. A
tool you use every day that Woopcode has never heard of will ask for approval,
and that is the classifier working correctly rather than failing.

**Every mode except `full-auto` refuses destructive and system commands.** This
is the guarantee the modes are built around, not a side effect of their
ordering. Raising the mode from `always-ask` to `auto-workspace` widens what
runs unattended, but it never puts `rm -rf` or `sudo` on the automatic side.

Redirection counts. `echo hi > file.txt` is a workspace write, not a read,
because of the `>`.

## What full-auto gives up

`full-auto` runs everything. No shell command stops, including the destructive
and system ones every other mode refuses.

```terminal
  rm -rf node_modules   ▶  runs
  git reset --hard      ▶  runs — uncommitted work is discarded
  sudo rm -rf /         ▶  runs
```

:::danger
Woopcode will not stop a command that destroys work in this mode. There is no
undo, no confirmation, and no second gate behind it. Use it in a container or a
scratch clone, on a branch you are willing to lose — not in a repository with
uncommitted work you care about.
:::

File edits still pause on a diff even here. That is the one protection that does
not depend on the mode.

## Changing it

In a session:

```text
/approval
```

The picker opens with the current mode marked. The choice is saved immediately.

For a headless run, `--prompt` approves tool edits and commands automatically so
the run can finish without a terminal to answer at. `--no-auto-approve` inverts
that — edits and commands are rejected rather than approved:

```bash
woopcode --prompt "summarise the auth flow" --no-auto-approve
```

That combination is the safe way to run Woopcode in CI: it can read and reason,
and anything that would change the checkout is refused rather than waited on.

## When it does not work

**A command you consider harmless keeps asking** — It is almost certainly not in
the classifier's tables and is being treated as destructive by default. Approve
it, or move to a mode whose ceiling covers it.

**`bun test` runs but `bun run build` asks** — `test` is classified read-only;
a general `run` script is not, because Woopcode cannot see what the script does.

**Nothing asks and you expected it to** — Check `/status`. A previous session
may have left the mode at `full-auto`; the setting is persisted, not per-session.

**A shell command hangs** — `run_terminal` and `run_tests` are meant for short,
non-interactive commands. They do not start servers or watch processes, and a
command that waits for input will sit there until the turn is cancelled.

## Next

- [Reviewing diffs](/docs/guides/reviewing-diffs) — the gate that no mode
  removes.
- [Tools](/docs/reference/tools) — which of the {{counts.tools}} tools write,
  which run shell commands, and which only read.
- [Slash commands](/docs/reference/slash-commands) — `/approval`, `/status`, and
  the rest.
