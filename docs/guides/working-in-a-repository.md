---
title: Working in a repository
type: guide
summary: What Woopcode knows about your project, where the workspace boundary is, and how to ask questions it can answer well.
prerequisites:
  - /docs/getting-started/first-session
related:
  - /docs/introduction/how-a-turn-works
  - /docs/reference/tools
since: 0.6.0
---

# Working in a repository

Woopcode operates on the directory it was launched from. Not the one your
editor has open, not the git root — the working directory of the process.

```bash
cd path/to/your-project
woopcode
```

Confirm it any time:

```text
/workspace
```

That reports the directory, the current git branch, and a file count.

## What it knows before you ask

At the start of a turn Woopcode assembles a short description of the project:

| Source | Cap |
| --- | --- |
| Package metadata summary | 2,000 characters |
| README | 4,000 characters |
| Top-level directory structure | — |
| The whole context, after assembly | 8,000 characters |

It does not include a file listing. That can be enormous on a real repository,
and the agent has `find_files`, `glob`, and `list_files` to look things up when
it needs them. The context is a starting point, not a snapshot — everything
else is read on demand.

A single file over 512 KB is not read into context.

## The workspace boundary

Every path a tool touches is resolved against the workspace root, and anything
that lands outside it is refused:

```terminal
Path escapes the workspace: ../other-project/src/index.ts
```

Symlinks are resolved before the check, so a link pointing out of the tree does
not get around it. If you need Woopcode to work on a different project, quit
and restart there.

## Asking questions it can answer well

**Name things.** "Where is the session cookie set" beats "how does auth work".
The agent searches for what you name, so a concrete noun from the codebase
saves it several lookups.

**Say what you want changed, not how.** "Add validation to the create-user
endpoint and cover it with tests" gives the agent room to find the right file.
Prescribing an approach when you have not read the code often produces a worse
edit than describing the outcome.

**Ask before you change.** A question costs one turn and no writes, and it
tells you whether the agent has understood the project before you let it edit.

**Keep the scope to one thing.** A turn works in stretches of 40 steps and asks
before taking another. Two unrelated changes in one prompt tends to mean
answering that question with neither of them finished.

## Git

Woopcode has no special git integration. It sees your working tree as files,
and it can run git commands through the shell tools subject to your approval
mode — `git status` and `git log` are classified read-only, `git add` and
`git commit` as workspace writes, and `git reset`, `git clean`, and
`git rebase` as destructive.

:::tip
Commit before a session where you expect several edits. Not because Woopcode is
reckless — every edit stops for review — but because a clean tree makes
`git diff` the record of what the session actually changed.
:::

## When it does not work

**The agent answers about the wrong project** — Check `/workspace`. You almost
certainly launched from a different directory than you meant.

**It cannot find a file you know exists** — It may be excluded from the
structure scan, which skips `node_modules`, `.git`, and `dist`. Name the path
directly and it will read it.

**It keeps re-reading the same file** — After four identical calls, the rest are
skipped with a notice. That usually means the turn has lost the thread; cancel
and re-ask more specifically.

## Next

- [Sessions & history](/docs/guides/sessions-and-history) — what carries over
- [Tools](/docs/reference/tools) — how it looks things up
