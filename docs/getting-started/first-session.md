---
title: Your first session
type: guide
summary: Point Woopcode at a repository and take it through one change, from prompt to applied diff.
prerequisites:
  - /docs/getting-started/install
  - /docs/getting-started/connect-a-provider
related:
  - /docs/guides/approval-modes
  - /docs/reference/slash-commands
since: 0.6.0
---

# Your first session

By the end of this page you will have run Woopcode in a real repository, read
its answer to a question about your own code, and applied one edit through the
diff review.

This page assumes Woopcode is [installed](/docs/getting-started/install) and a
[provider is connected](/docs/getting-started/connect-a-provider). One command
confirms both:

```bash
woopcode providers list
```

## Start it in a repository

Woopcode reads the directory it is launched from, so this is the step that
decides what it can see:

```bash
cd path/to/your-project
woopcode
```

## Ask it something first

Start with a question rather than a change. It costs nothing, it shows you how
the agent moves through your repository, and it tells you whether it has
understood the codebase before you let it edit anything.

```text
Explain how authentication is structured in this repository.
```

Woopcode streams its work as it goes. You will see tool calls appear as they
run — reading a file, grepping for a symbol, listing a directory — and then the
answer builds underneath them. Nothing in that sequence writes to disk; every
tool used to answer a question is read-only.

## Make one change

Now ask for something small and specific:

```text
Add a docstring to the login handler explaining what it returns.
```

When the agent is ready to change an existing file, it stops. It does not write
and then tell you. It shows the edit as a unified diff and waits:

```diff
 ← Editing  src/auth/login.ts                        +6 −0

   export async function login(req: Request) {
+    /**
+     * Exchanges a set of credentials for a session cookie.
+     *
+     * Returns 401 with an empty body when the password
+     * does not match; never reveals if the account exists.
+     */
     const body = await req.json();

 Esc reject · ↑↓ scroll                    Enter apply
```

Press <kbd>Enter</kbd> to apply the edit, or <kbd>Esc</kbd> to reject it.
Rejecting is not an error — the agent is told the edit was declined and carries
on from there, so you can reject a diff and immediately explain what you wanted
instead.

That pause is the part of Woopcode worth understanding properly. It applies to
every edit to an existing file, and it is not the same mechanism that governs
shell commands. Those are controlled separately — see
[Approval modes](/docs/guides/approval-modes) before you run anything that
builds or tests.

## What to do next in the same session

A few commands are worth knowing on day one:

| Command | What it does |
| --- | --- |
| `/help` | List every command |
| `/status` | Show the provider, model, and approval mode in use |
| `/approval` | Change how much runs without asking |
| `/new` | Clear the conversation and start fresh |
| `/workspace` | Show the repository Woopcode thinks it is in |

Your conversation is saved after every turn, so quitting and restarting resumes
where you left off. `/new` is how you deliberately drop that history.

:::warning
There is one history file, not one per repository. Starting Woopcode in a
different project resumes the same conversation, so run `/new` when you switch
— otherwise the agent begins with context from somewhere else entirely.
:::

## When it does not work

**`Path escapes the workspace: ../other-project/file.ts`** — The agent tried to
reach outside the directory you launched it in. Woopcode resolves every path
against the workspace root and refuses anything above it, symlinks included.
Restart it inside the directory you actually want it to work on.

**The agent answers about the wrong project** — Check `/workspace`. Woopcode
uses the directory it was launched from, not the one your editor has open.

**A shell command you expected to run stopped and asked** — That is the
approval mode doing its job. The default runs reads and tests without asking
and stops before anything that writes.

Trouble before you get this far is covered where it belongs:
[Install](/docs/getting-started/install#when-it-does-not-work) for `bun:
command not found`, [Connect a
provider](/docs/getting-started/connect-a-provider#when-it-does-not-work) for a
rejected API key.

## Next

- [Approval modes](/docs/guides/approval-modes) — decide how much runs without
  asking, and understand what `full-auto` gives up.
- [Reviewing diffs](/docs/guides/reviewing-diffs) — scrolling long diffs, and
  what happens to a rejected edit.
- [Tools](/docs/reference/tools) — the {{counts.tools}} tools the agent can
  call, and which of them can change your files.
