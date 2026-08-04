---
title: Keyboard
type: reference
summary: Every key Woopcode responds to, and what Ctrl+C means in each situation.
prerequisites: []
related:
  - /docs/guides/reviewing-diffs
  - /docs/reference/slash-commands
since: 0.6.0
---

# Keyboard

## At the prompt

| Key | Action |
| --- | --- |
| <kbd>Enter</kbd> | Send the prompt |
| <kbd>Tab</kbd> | Switch between [Build and Plan](/docs/guides/plan-mode) |
| <kbd>↑</kbd> <kbd>↓</kbd> | Scroll the conversation a line at a time |
| <kbd>PgUp</kbd> <kbd>PgDn</kbd> | Scroll a screen at a time |
| <kbd>Home</kbd> | Jump to the start of the conversation |
| <kbd>End</kbd> | Jump back to the latest output |

The arrow keys scroll rather than recall: there is no prompt history, so
<kbd>↑</kbd> does not bring back what you typed last.

<kbd>Tab</kbd> is not slash completion — <kbd>Enter</kbd> already does that from
the highlighted row. The composer changes colour and the caret follows, so the
mode is visible without looking anywhere else.

## Completing a slash command

Typing `/` opens the list of matching commands, and while that list is showing
the arrow keys belong to it rather than to the conversation.

| Key | Action |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move through the matches |
| <kbd>Enter</kbd> | Complete the prompt to the selected command |
| <kbd>Enter</kbd> again | Run it |

The first <kbd>Enter</kbd> completes rather than runs, so `/appr` +
<kbd>Enter</kbd> becomes `/approval ` and waits. Typing a command in full skips
that step — the list has nothing left to complete, so <kbd>Enter</kbd> runs it.

## Reviewing a diff

An edit to an existing file pauses on a diff. It shares the screen with the
conversation rather than covering it.

| Key | Action |
| --- | --- |
| <kbd>Enter</kbd> | Apply the edit |
| <kbd>Esc</kbd> | Reject it |
| <kbd>↑</kbd> <kbd>↓</kbd> | Scroll a line at a time |
| <kbd>PgUp</kbd> <kbd>PgDn</kbd> | Scroll a screen at a time |
| <kbd>Home</kbd> | Jump to the top of the diff |
| <kbd>End</kbd> | Jump to the bottom |

## Approving a command

A shell command that needs asking opens a dialog of its own, with the command as
it will be run and the reason it stopped.

| Key | Action |
| --- | --- |
| <kbd>Enter</kbd> or <kbd>A</kbd> | Run it |
| <kbd>Esc</kbd> or <kbd>R</kbd> | Refuse, and tell the agent so |

Which commands stop here at all is the [approval
mode](/docs/guides/approval-modes), not this dialog.

## Answering a question

The agent can ask you something mid-turn. Questions arrive as a set and are
answered one at a time.

| Key | Action |
| --- | --- |
| <kbd>Enter</kbd> | Submit this answer and move to the next |
| <kbd>Esc</kbd> | Cancel the whole set |

## Pickers

`/models` and `/approval` open a picker. `/provider` does not — it prints the
configured providers as text.

| Key | Action |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move the selection |
| <kbd>Enter</kbd> | Choose it, and save |
| <kbd>Esc</kbd> | Close without changing anything |

The two differ in one way: the model picker has a search field, so typing
narrows the list. The approval picker has a short fixed list and no search, so
typing does nothing there.

## Ctrl+C

<kbd>Ctrl</kbd><kbd>C</kbd> means different things depending on what the session
is doing, and the order is deliberate:

| Situation | What it does |
| --- | --- |
| A turn is running | Cancels the turn — including one parked on an approval |
| A window is open, nothing running | Closes the window |
| Nothing running, no window | Exits Woopcode |

Stopping the agent outranks closing the window waiting on it. A dialog open
mid-turn *is* the agent asking a question, so cancelling the turn is what you
mean; the dialog comes down on the way out.

With nothing running, one press closes the window and a second exits. Quitting
the whole session on the first press would be a surprising amount of
destruction for one keystroke.

:::note
<kbd>Esc</kbd> rejects the thing in front of you. It does not stop the agent.
Use <kbd>Ctrl</kbd><kbd>C</kbd> for that.
:::

## On a short terminal

Every dialog prints its keys along the bottom, and that row is the first thing
dropped when the window is too short to hold both it and the thing being
decided. The keys still work — this page is where they live when the hint is
gone.

## See also

- [Reviewing diffs](/docs/guides/reviewing-diffs)
- [Slash commands](/docs/reference/slash-commands)
