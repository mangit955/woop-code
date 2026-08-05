---
title: Sessions & history
type: guide
summary: What Woopcode remembers between runs, what it deliberately forgets, and how to clear it.
prerequisites:
  - /docs/getting-started/first-session
related:
  - /docs/reference/configuration
  - /docs/introduction/how-a-turn-works
since: 0.6.0
---

# Sessions & history

Your conversation is saved after every turn. Quit, come back, and Woopcode
picks up where you left off.

## Clearing it

```text
/new
```

That drops the saved history and starts fresh. There is no undo.

## What is saved

Only your messages and the agent's replies.

Tool calls and their results are dropped. They are the bulk of a long
transcript, they only mean anything to the turn that produced them, and
persisting half of a call/result pair would make the restored history invalid
for the provider — the model would see a request to run a tool with no record
of what it returned.

The most recent 100 messages are kept. Older ones fall off the end.

## What is sent to the model

Saved and sent are different numbers. Only the most recent **six turns** go to
the model on any request, however much history is on disk. That is what keeps a
long session from growing without limit.

So a fact from twenty turns ago is in your history file but not in the model's
context. If something matters, restate it.

## Where it lives

`conversation.json` in your config directory:

| Platform | Path |
| --- | --- |
| macOS, Linux | `~/.config/woopcode/conversation.json` |

:::warning
There is one history file, not one per repository. Starting Woopcode in a
different project resumes the same conversation. Use `/new` when you switch
projects, or the agent begins with context from somewhere else entirely.
:::

## How it is written

After every turn, to a temporary file that is then renamed over the real one.
The rename is atomic on the same filesystem, so a crash mid-write leaves you
with either the old file or the new one — never half a transcript.

A `conversation.json` that is not valid JSON is moved aside to
`conversation.json.corrupt-<timestamp>` and history starts empty. Your broken
copy is kept.

## Privacy

The file is plain JSON in your home directory. Everything you typed and
everything the agent replied is in it, in the clear. If you paste a secret into
a prompt, it is on disk until you run `/new`.

## When it does not work

**It resumed a conversation from another project** — Expected; history is
global. `/new`.

**History looks truncated** — Only the last 100 messages are kept.

**The agent forgot something from earlier in the session** — It is in the file
but outside the six-turn window sent to the model. Restate it.

## Next

- [Configuration](/docs/reference/configuration) — the rest of what is stored
- [Working in a repository](/docs/guides/working-in-a-repository)
