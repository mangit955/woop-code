---
title: Reviewing diffs
type: guide
summary: The gate that no approval mode removes — reading the diff, applying it, and what happens when you reject.
prerequisites:
  - /docs/getting-started/first-session
related:
  - /docs/guides/approval-modes
  - /docs/reference/keyboard
since: 0.6.0
---

# Reviewing diffs

Every edit to an existing file stops and shows you a unified diff before
anything is written. This is the one protection that does not depend on your
approval mode.

## What you see

```diff
 ← Editing  src/auth/login.ts                        +6 −0

   export async function login(req: Request) {
+    /**
+     * Exchanges a set of credentials for a session cookie.
+     */
     const body = await req.json();

 Esc reject · ↑↓ scroll                    Enter apply
```

The header names the action and the file, and counts the lines added and
removed. Added lines carry `+`, removed lines `−`.

| Key | Action |
| --- | --- |
| <kbd>Enter</kbd> | Apply the edit |
| <kbd>Esc</kbd> | Reject it |
| <kbd>↑</kbd> <kbd>↓</kbd> | Scroll, when the diff is longer than the screen |

## Which tools stop here

{{tools-table:write}}

Creating a *new* file is also shown before it is written — an empty file is a
valid thing to create, and you should still get to see it coming.

## Rejecting is a normal move

<kbd>Esc</kbd> is not an error and not a cancellation. The agent is told the
edit was declined and continues from there, so the useful pattern is to reject
and immediately say what you wanted instead:

```text
Not quite — keep the existing return type and only add the docstring.
```

The rejected edit stays in the conversation as context, so you do not have to
re-explain the whole task.

To stop the turn entirely rather than decline one edit, use
<kbd>Ctrl</kbd><kbd>C</kbd>. <kbd>Esc</kbd> rejects what is in front of you;
it does not stop the agent.

## Reading a long diff

Diffs longer than the screen scroll with the arrow keys. Two habits help:

**Check the counts first.** `+6 −0` on a docstring is expected. `+6 −40` is
worth reading closely.

**Check the file path.** It is the fastest way to catch an edit aimed at the
wrong file — a test instead of the source, or a generated file that will be
overwritten.

## Why the review is here and not in git

An agent that writes first and lets you inspect afterwards is faster right up
until it is wrong, and then you are reading `git diff` reconstructing what
happened and why. Reviewing before the write means the change never lands, the
agent learns immediately, and your working tree is never in a state you did not
choose.

:::note
This gate covers file edits. Shell commands are governed separately by the
[approval mode](/docs/guides/approval-modes) — a command that writes a file is
checked there, not here.
:::

## When it does not work

**A diff appeared for a file you did not expect** — Reject it. The agent
inferred the wrong target; say which file you meant.

**The diff is enormous** — Reject and narrow the request. A turn that produces
a several-hundred-line diff has usually misunderstood the scope, and reviewing
it properly costs more than redoing the ask.

**No diff appeared and a file changed anyway** — That was a shell command, not
an edit tool. Check your approval mode with `/status`.

## Next

- [Approval modes](/docs/guides/approval-modes) — the other gate
- [Keyboard](/docs/reference/keyboard) — every key
