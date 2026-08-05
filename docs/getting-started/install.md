---
title: Install
type: guide
summary: Get Bun, then get Woopcode — as a one-off run or a global install.
prerequisites: []
related:
  - /docs/getting-started/first-session
  - /docs/getting-started/connect-a-provider
since: 0.6.0
---

# Install

Woopcode requires [Bun](https://bun.sh) 1.0 or later. It is built on Bun's
runtime, not merely packaged with it, so Node will not do.

```bash
bun --version
```

If that prints nothing, install Bun first — one command, no root:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Install Woopcode

:::tabs
@tab Run it once
```bash
bunx woopcode
```
@tab Install it
```bash
bun add -g woopcode
```
:::

`bunx` fetches and runs it without installing, which is the right way to try
it. A global install puts `woopcode` on your path for everyday use.

## Check it

```bash
woopcode --version
```

## What it needs

| | |
| --- | --- |
| Runtime | Bun 1.0+ |
| Platforms | macOS, Linux — on Windows, use WSL |
| Network | Outbound HTTPS to the provider |
| Account | A Google Gemini API key — [free to create](https://aistudio.google.com/apikey) |

## When it does not work

**`bun: command not found`** — Bun is not installed or not on your path. Install
it, then open a new terminal so your shell picks up the change.

**`woopcode: command not found` after a global install** — Bun's global bin
directory is not on your `PATH`. `bun pm bin -g` prints it; add that to your
shell profile.

**Permission errors during install** — do not reach for `sudo`. Bun installs
into your home directory, and a global install run as root leaves files your
user cannot update later.

## Next

- [Connect a provider](/docs/getting-started/connect-a-provider) — the API key
- [Your first session](/docs/getting-started/first-session) — one change, end
  to end
