---
title: What Woopcode is
type: concept
summary: A terminal-native coding agent that reads the repository you are in, shows its work, and pauses on a diff before it changes a line.
prerequisites: []
related:
  - /docs/introduction/how-a-turn-works
  - /docs/getting-started/first-session
since: 0.6.0
---

# What Woopcode is

Woopcode is a coding agent that runs in your terminal, inside the repository
you are already working in. You ask it to investigate, explain, implement,
review, or test something. It reads what it needs, calls tools, streams what it
is doing, and stops for your approval before it writes to an existing file.

## What it is not

It is not an editor, an extension, or a browser tab. There is no project to
open and no index to build — it starts in the directory you launch it from and
discovers the rest on demand.

It is not an autonomous agent you hand a task to and walk away from. The design
assumes you are watching: the work streams as it happens, and the parts that
change your code stop and ask.

## The three things it is built around

**It starts from your repository.** Package metadata, the README, and the
top-level structure are loaded up front, budgeted rather than dumped. Anything
deeper is read on demand, because the agent can open any file it needs.

**It shows its work.** Tool calls appear as they run — the file being read, the
pattern being searched. You can follow the reasoning rather than waiting behind
a spinner and being handed a result.

**It stops before it writes.** Every edit to an existing file is presented as a
unified diff and waits for you. Shell commands are governed separately, by an
approval mode you choose.

That last one is the load-bearing idea. An agent that edits silently is faster
right up until the moment it is wrong, and then you are reading a git diff
trying to work out what happened. Woopcode moves that review to before the
write.

## Where it is today

:::note
Woopcode is early. Google Gemini is the only implemented provider — other
entries appear in configuration so you can see they are planned, but they do
not run. The Gemini path is the one that is finished.
:::

It is open source under the MIT licence and built on [Bun](https://bun.sh).

## Next

- [Why use it](/docs/introduction/why) — what it is good at, and what it is not
- [How a turn works](/docs/introduction/how-a-turn-works) — the loop, end to end
- [Your first session](/docs/getting-started/first-session) — install it and
  take it through one change
