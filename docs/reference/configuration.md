---
title: Configuration
type: reference
summary: Where Woopcode stores its settings, what each key means, and what happens when the file breaks.
prerequisites: []
related:
  - /docs/guides/configuring-providers
  - /docs/guides/sessions-and-history
since: 0.6.0
---

# Configuration

## Location

| Platform | Directory |
| --- | --- |
| macOS, Linux | `$XDG_CONFIG_HOME/woopcode/`, or `~/.config/woopcode/` |
| Windows | `%LOCALAPPDATA%\woopcode\` |

The directory is created on first run.

| File | Contents |
| --- | --- |
| `providers.json` | Provider keys, the default provider, the selected model, the approval mode |
| `conversation.json` | Saved conversation history |
| `models.json` | The model list |

Configuration is global, not per-repository. Conversation history is the one
thing scoped to where you are working.

## `providers.json`

```json
{
  "defaultProvider": "google",
  "selectedModel": "gemini-3.6-flash",
  "approvalMode": "auto-read-only",
  "providers": {
    "google": { "type": "api", "apiKey": "..." }
  }
}
```

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultProvider` | `string` | `"google"` | Which provider a session starts with |
| `selectedModel` | `string` | first model of the provider | Model id, as listed by `woopcode models` |
| `approvalMode` | `string` | `"auto-read-only"` | One of the four [approval modes](/docs/guides/approval-modes) |
| `providers` | `object` | three entries | Keyed by provider id |
| `providers.<id>.type` | `string` | `"api"` | How the provider authenticates |
| `providers.<id>.apiKey` | `string` | `""` | The stored key |

Unrecognised keys are preserved when Woopcode rewrites the file, so anything
you add by hand survives.

:::warning
`apiKey` is stored in plain text, with no encryption and no keychain
integration. The file is only as protected as your home directory.
:::

## Editing it by hand

You can, and Woopcode will read it. The safer path for the values that have a
command is to use the command, because it validates:
[`woopcode providers login`](/docs/reference/cli) verifies a key before saving
it, and `/approval` cannot write a mode that does not exist.

An approval mode the parser does not recognise falls back to the default rather
than being treated as permissive. An unreadable setting must not be able to
widen what runs without asking.

## When the file is corrupt

A `providers.json` or `conversation.json` that is not valid JSON — a truncated
write, a bad hand edit — is moved aside rather than crashing every command that
touches it:

```terminal
Could not read provider config (invalid JSON). Moved it to
~/.config/woopcode/providers.json.corrupt-1785508675645 and started from
defaults.
```

Your broken copy is kept under that `.corrupt-<timestamp>` name; the next
launch starts clean.

## Retired providers

A provider that an earlier version offered and Woopcode has since dropped is
removed from your config on startup — but only if it has no key stored. An
entry with a key is left alone: deleting a credential silently would hide
something you may want to remove yourself.

## Environment

### Location

| Variable | Effect |
| --- | --- |
| `XDG_CONFIG_HOME` | Moves the config directory on macOS and Linux |
| `LOCALAPPDATA` | Moves the config directory on Windows |

### Credentials

Woopcode reads an API key from the environment when one is present, and prefers
it over the stored config. This is what lets it run somewhere with no writable
home directory and no terminal to run setup in — a CI job, a benchmark
container built fresh for every trial.

They are checked in this order, and the first one set wins:

| Variable | Provider |
| --- | --- |
| `WOOPCODE_API_KEY` | Whatever `WOOPCODE_PROVIDER` names, or `google` |
| `GEMINI_API_KEY` | `google` |
| `GOOGLE_API_KEY` | `google` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | `google` |
| `OPENAI_API_KEY` | `openai` |
| `ANTHROPIC_API_KEY` | `anthropic` |

An unusable provider is treated differently depending on which variable named
it. `WOOPCODE_API_KEY` with `WOOPCODE_PROVIDER` is an instruction addressed to
Woopcode, so naming a provider it has no client for is an error at startup
rather than a failure on the first turn. A vendor variable is not an
instruction — `ANTHROPIC_API_KEY` is usually exported for some other tool
sharing the shell — so an unusable one is skipped and the search continues to
the next, or to the stored config.

:::note
A key in the environment is used as-is and never written to `providers.json`.
Nothing is stored, which is the point for a container that is discarded after
the run.
:::

### Behaviour

| Variable | Default | Effect |
| --- | --- | --- |
| `WOOPCODE_PROVIDER` | `google` | Pairs with `WOOPCODE_API_KEY` |
| `WOOPCODE_MAX_ITERATIONS` | `40` | Steps a turn may take before it stops to ask whether to keep going. Interactively the ceiling is a checkpoint, so it is set to catch a stuck loop rather than to ration requests — the provider rations those itself, and answering the checkpoint grants another `40`. A headless run has nobody to ask, so this is the whole budget and exhausting it exits `2` |
| `WOOPCODE_MAX_ATTEMPTS` | `3` | Tries per provider request before the error surfaces |
| `WOOPCODE_TOOL_HISTORY_BUDGET` | unset (off) | Characters of tool history to keep before older results are compacted. Off by default — see the measurements in `runtime/compaction.ts` |
| `WOOPCODE_THINKING_BUDGET` | `-1` | Reasoning depth; see below |
| `WOOPCODE_NON_INTERACTIVE` | unset | `1` stops Woopcode opening the setup wizard, so a missing key fails loudly instead of blocking on a prompt nothing can answer. `CI=true` does the same |

A value that is not a positive integer is ignored with a warning on stderr, and
the default is used. An unreadable setting never silently changes behaviour.

### `WOOPCODE_THINKING_BUDGET`

Takes `off`, `-1` (automatic, the default), or a token count. The three
providers accept different things, so the same value does not mean the same
thing everywhere — and a number is never faked into a budget the provider did
not apply.

| Value | Google | OpenAI | Anthropic |
| --- | --- | --- | --- |
| `off` | No thinking config sent | `reasoning.effort: none` | `thinking: disabled` |
| `-1` | Model decides | Model default | Model decides |
| a count | Used as the token budget | Model default | Model decides |

Only Gemini takes a token count. Current Claude models reject an explicit
budget, and OpenAI takes an effort level rather than a number, so on both a
count falls back to letting the model decide — which is what `-1` already
meant. On Gemini, budgets below roughly a thousand are ignored by the model
rather than honoured.

## See also

- [Configuring providers](/docs/guides/configuring-providers) — the task, not
  the schema
- [Sessions & history](/docs/guides/sessions-and-history) — what
  `conversation.json` holds
