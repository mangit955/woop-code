---
title: Connect a provider
type: guide
summary: Create a Google Gemini API key and give it to Woopcode, from the setup flow or the command line.
prerequisites:
  - /docs/getting-started/install
related:
  - /docs/guides/configuring-providers
  - /docs/reference/configuration
since: 0.6.0
---

# Connect a provider

Woopcode needs an API key before it can do anything.

:::note
Google Gemini, OpenAI and Anthropic Claude all run. Any provider
`woopcode providers list` shows will give you a working session.
:::

## Get a key

Create one at [Google AI Studio](https://aistudio.google.com/apikey). It is
free to generate and takes about a minute.

## Give it to Woopcode

The first launch asks for it:

```terminal title="woopcode — setup"
  Welcome to Woopcode!

  You can create a free API key at:
  https://aistudio.google.com/apikey

  Paste your Google Gemini API key:
  > ...

  ✓ API key verified
```

The key is checked against the provider before it is saved, so a bad paste
fails here rather than halfway through your first turn.

Or do it from your shell, which is the better option when the key is already in
an environment variable:

```bash
woopcode providers login --provider google --api-key "$GOOGLE_API_KEY"
```

## Confirm it

```bash
woopcode providers list
```

Inside a session, `/status` shows the provider, the model, and the approval
mode in one line.

## Where the key goes

Into `providers.json` in your config directory — `~/.config/woopcode/` on macOS
and Linux.

:::warning
The key is stored in plain text. There is no encryption and no keychain
integration; the file is only as protected as your home directory. Use a key
scoped to development, and remove it with `woopcode providers logout` when you
are done.
:::

## When it does not work

**`Invalid API key. Please try again.`** — The key was rejected before being
saved. Check for a trailing space or newline in the paste, and confirm it is a
Google AI Studio key rather than a Google Cloud one.

**The setup flow does not appear** — A key is already stored. `/login` inside a
session, or `woopcode providers login`, replaces it.

**Requests fail after working yesterday** — The key may have been revoked or
hit a quota. Google AI Studio shows both.

## Next

- [Your first session](/docs/getting-started/first-session)
- [Configuring providers](/docs/guides/configuring-providers) — switching
  models, changing the default
