---
title: Configuring providers
type: guide
summary: Switch models, rotate a key, change the default provider — from a session or your shell.
prerequisites:
  - /docs/getting-started/connect-a-provider
related:
  - /docs/reference/configuration
  - /docs/reference/cli
since: 0.6.0
---

# Configuring providers

Everything here can be done two ways: from inside a session with a slash
command, or from your shell with `woopcode providers`. The slash command opens
a picker; the CLI is what you script.

## See what is configured

:::tabs
@tab In a session
```text
/status
```
@tab From your shell
```bash
woopcode providers list
```
:::

`/status` gives you the provider, model, and approval mode in one line.
`providers list` gives you every provider with its default and auth status.

## Change the model

```text
/model
```

The picker lists the models for your current provider. The choice is saved and
survives restarts.

From the shell you can see what is available, though not select it:

```bash
woopcode models
```

All current models are Gemini, with a one-million-token context window. The
practical difference is speed against capability: `flash-lite` is quickest,
`flash` is the middle, `pro` is the most capable and the slowest.

:::tip
Start on `flash` for exploration and questions, and move to `pro` when a change
needs real reasoning about your code. Most turns do not.
:::

## Rotate a key

:::tabs
@tab In a session
```text
/login
```
@tab From your shell
```bash
woopcode providers login --provider google --api-key "$NEW_KEY"
```
:::

The new key is validated before it replaces the old one, so a bad paste leaves
you with a working setup.

The session you are in keeps using the client it started with. A `/login` does
not silently redirect the turn you are in the middle of — switch the provider
to pick it up, or restart.

## Remove a key

```bash
woopcode providers logout --provider google
```

Do this when you are done on a shared or temporary machine. The key is stored
in plain text and `logout` is what removes it.

## Change the default provider

```bash
woopcode providers set --provider google
```

:::note
Google Gemini, OpenAI and Anthropic Claude all run, so any of them can be set
as the default.
:::

## Where this is written

All of it lands in `providers.json` in your config directory. See
[Configuration](/docs/reference/configuration) for the schema, and for what
happens when that file is corrupt.

## When it does not work

**`Invalid API key. Please try again.`** — Rejected before saving. Check for a
trailing newline in the paste, and that it is a Google AI Studio key rather
than a Google Cloud one.

**The model picker is empty** — No models are registered for the selected
provider. Switch back to `google`.

**A model you selected is no longer used** — Selecting a provider whose model
list does not include your saved model resets it to that provider's first
model.

**Changes are not taking effect** — Some changes apply to the next session
rather than the running one. Restart.

## Next

- [Configuration](/docs/reference/configuration) — the file itself
- [Approval modes](/docs/guides/approval-modes) — the other saved setting
