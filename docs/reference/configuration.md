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

| Variable | Effect |
| --- | --- |
| `XDG_CONFIG_HOME` | Moves the config directory on macOS and Linux |
| `LOCALAPPDATA` | Moves the config directory on Windows |

Woopcode does not read an API key from the environment. Pass it once through
`woopcode providers login`, which stores it.

## See also

- [Configuring providers](/docs/guides/configuring-providers) — the task, not
  the schema
- [Sessions & history](/docs/guides/sessions-and-history) — what
  `conversation.json` holds
