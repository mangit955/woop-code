---
title: Sessions & history
type: guide
summary: How Woopcode saves a conversation per project, and how to resume, name, branch and prune them.
prerequisites:
  - /docs/getting-started/first-session
related:
  - /docs/reference/configuration
  - /docs/introduction/how-a-turn-works
since: 0.6.0
---

# Sessions & history

A session is one saved conversation, belonging to the project it happened in.
It is written after every turn, so nothing is lost when you quit — but coming
back to it is something you ask for.

## Resuming

Starting Woopcode opens a fresh session. Going back to an old one:

| Command | What it does |
| --- | --- |
| `woopcode --continue` | Reopen the newest session in this project |
| `woopcode --resume <name-or-id>` | Reopen a particular one |
| `woopcode --resume` | Pick from a list before starting |
| `woopcode --new` | Start fresh — what a bare launch already does |
| `/resume` | Pick from a list, without leaving the session you are in |
| `/resume <name-or-id>` | Switch straight to one |
| `/sessions` | List what is saved in this project |

An id prefix is enough — the first eight characters, as `/sessions` prints
them. A reference that matches more than one session is reported rather than
guessed at.

## Naming

```text
/rename auth-refactor
```

Until you name it, a session is titled from its first prompt, which is what the
picker shows. A name is also a resume handle: `woopcode --resume auth-refactor`.

## Starting a new one

```text
/new
```

The conversation you were in is saved, not deleted, and `/new` prints the id to
get back to it. This is the difference from older versions, where `/new` dropped
the transcript with no undo.

## Branching

```text
/branch try-streaming
```

Copies the conversation so far into a new session and continues there, leaving
the original untouched — for trying a second approach without losing the first.
From the command line, `woopcode --continue --fork-session` does the same.

## What is saved

Only your messages and the agent's replies.

Tool calls and their results are dropped. They are the bulk of a long
transcript, they only mean anything to the turn that produced them, and
persisting half of a call/result pair would make the restored history invalid
for the provider — the model would see a request to run a tool with no record
of what it returned.

The most recent 100 messages are kept. Older ones fall off the end.

Each session also carries its own execution log — the one-line record of what
it did — so a resumed session knows what it already tried, and a new one starts
without inheriting another project's work.

## What is sent to the model

Saved and sent are different numbers. Only the most recent **six turns** go to
the model on any request, however much history is on disk. That is what keeps a
long session from growing without limit.

So a fact from twenty turns ago is in your history file but not in the model's
context. If something matters, restate it.

## Where it lives

Under `sessions/` in your config directory, one directory per project:

| Platform | Path |
| --- | --- |
| macOS, Linux | `~/.config/woopcode/sessions/<project>/<session-id>.json` |

The project directory is named after the repository root, with a hash of its
full path appended so two projects with similar names cannot share a store.
`index.json` beside the sessions is a cache the picker reads; deleting it costs
a directory scan and nothing else.

History saved by a version before sessions existed is imported once, into a
`legacy` bucket. It was one file shared by every repository, so no project can
honestly claim it — find it with <kbd>Ctrl</kbd><kbd>A</kbd> in `/resume`.

Resuming it and taking a turn moves it into the project you are working in, and
it appears in that project's list from then on. Opening it to read does not:
only a turn moves it, so browsing old history leaves it where it is.

## Retention

Sessions are deleted 30 days after their last turn. Change it in
`providers.json`:

```json
{ "retentionDays": 90 }
```

`0` keeps them forever. `woopcode sessions prune` runs it on demand.

## Two windows on one conversation

Two windows land on the same conversation when both resume it — `--continue` in
each, or `/resume` onto one the other already has open. Each turn writes the
whole record, so the second window would overwrite the first's work.

It does not: a session that changed underneath a window is detected, and that
window's turn is kept as a branch with its own id, leaving the other window's
conversation exactly as it was. You are told when it happens.

```text
⚠️ This conversation was changed by another Woopcode window.
   Continuing in a branch (3f9c1a2b); nothing was overwritten.
```

To work in two windows deliberately, `/branch` in one of them first and skip the
notice.

## How it is written

After every turn, to a temporary file that is then renamed over the real one.
The rename is atomic on the same filesystem, so a crash mid-write leaves you
with either the old file or the new one — never half a transcript.

A session file that is not valid JSON is moved aside to
`<id>.json.corrupt-<timestamp>` and skipped. Your broken copy is kept, and the
rest of your sessions still open.

Nothing is written until a turn has run, so starting Woopcode and quitting
leaves no empty session behind.

## Non-interactive runs

`woopcode -p` starts its own session rather than continuing the one you have
open, and prints its id to stderr. Pass `--resume <id>` to continue it, or
`--no-session-persistence` to leave nothing behind.

## Privacy

Sessions are plain JSON in your home directory. Everything you typed and
everything the agent replied is in them, in the clear. If you paste a secret
into a prompt, it is on disk until that session is deleted or aged out.

## When it does not work

**It did not resume what I expected** — Sessions belong to a project. Run
Woopcode from the same repository, or use `/resume` and widen with
<kbd>Ctrl</kbd><kbd>A</kbd>.

**`--resume` says no session found** — The reference did not match anything in
this project. `woopcode sessions list --all` shows every one on the machine.

**History looks truncated** — Only the last 100 messages are kept.

**The agent forgot something from earlier in the session** — It is in the file
but outside the six-turn window sent to the model. Restate it.

## Next

- [Configuration](/docs/reference/configuration) — the rest of what is stored
- [Working in a repository](/docs/guides/working-in-a-repository)
