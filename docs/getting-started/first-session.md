---
title: Your first session
type: guide
summary: Install Woopcode, point it at a repository, and take it through one change from prompt to applied diff.
prerequisites: []
related:
  - /docs/guides/approval-modes
  - /docs/reference/slash-commands
since: 0.6.0
---

# Your first session

By the end of this page you will have run Woopcode in a real repository, read
its answer to a question about your own code, and applied one edit through the
diff review.

## Install and start

Woopcode needs [Bun](https://bun.sh) 1.0 or later. Run it without installing:

```bash
bunx woopcode
```

Or install it once and keep it on your path:

```bash
bun add -g woopcode
```

Then start it inside the repository you want to work on. Woopcode reads the
directory it is launched from, so this matters:

```bash
cd path/to/your-project
woopcode
```

## Connect a provider

On first launch Woopcode opens the setup flow and asks for an API key. Google
Gemini is the only implemented provider; other entries may appear in
configuration files, but they do not run.

```text
  Welcome to Woopcode!

  You can create a free API key at:
  https://aistudio.google.com/apikey

  Paste your Google Gemini API key:
  > ...

  ✓ API key verified
```

The key is validated before it is saved, so a bad paste fails here rather than
halfway through your first turn. You can do the same thing from the command
line instead:

```bash
woopcode providers login --provider google --api-key "$GOOGLE_API_KEY"
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

```text
  ← Editing  src/auth/login.ts                              +6 −0

    export async function login(req: Request) {
  +   /**
  +    * Exchanges a set of credentials for a session cookie.
  +    *
  +    * Returns 401 with an empty body when the password does not
  +    * match; never reveals whether the account exists.
  +    */
      const body = await req.json();

  Esc reject · ↑↓ scroll                              Enter apply
```

Press **Enter** to apply the edit, or **Esc** to reject it. Rejecting is not an
error — the agent is told the edit was declined and carries on from there, so
you can reject a diff and immediately explain what you wanted instead.

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

Your conversation is saved after every turn, so quitting and restarting in the
same repository resumes where you left off. `/new` is how you deliberately drop
that history.

## When it does not work

**`bun: command not found`** — Bun is not installed or not on your path.
Install it from [bun.sh](https://bun.sh), then reopen your terminal.

**`Invalid API key. Please try again.`** — The setup flow rejected the key
before saving it. Check for a trailing space or newline in the paste, and
confirm the key is a Google AI Studio key rather than a Google Cloud one.

**`Path escapes the workspace: ../other-project/file.ts`** — The agent tried to
reach outside the directory you launched it in. Woopcode resolves every path
against the workspace root and refuses anything above it, symlinks included.
Restart it inside the directory you actually want it to work on.

**The agent answers about the wrong project** — Check `/workspace`. Woopcode
uses the directory it was launched from, not the one your editor has open.

**A shell command you expected to run stopped and asked** — That is the
approval mode doing its job. The default runs reads and tests without asking
and stops before anything that writes.

## Next

- [Approval modes](/docs/guides/approval-modes) — decide how much runs without
  asking, and understand what `full-auto` gives up.
- [Reviewing diffs](/docs/guides/reviewing-diffs) — scrolling long diffs, and
  what happens to a rejected edit.
- [Tools](/docs/reference/tools) — the {{counts.tools}} tools the agent can
  call, and which of them can change your files.
