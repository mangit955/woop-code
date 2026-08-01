---
title: CLI
type: reference
summary: Every command, flag, and subcommand Woopcode accepts from your shell.
prerequisites: []
related:
  - /docs/reference/slash-commands
  - /docs/guides/configuring-providers
since: 0.6.0
---

# CLI

```bash
woopcode [options] [command]
```

With no command, Woopcode starts the interactive session in the current
directory.

## Options

| Option | Description |
| --- | --- |
| `-p, --prompt <prompt>` | Run a single prompt without the interface and exit |
| `--no-auto-approve` | With `--prompt`, reject tool edits and commands instead of approving them |
| `-V, --version` | Print the version |
| `-h, --help` | Print usage |

## Commands

| Command | Description |
| --- | --- |
| `woopcode` | Start the interactive session |
| `woopcode agent` | The same thing, named explicitly |
| `woopcode models` | List the models Woopcode knows about |
| `woopcode providers` | Inspect and configure providers |

## `woopcode`

Starts the session in the current working directory. Woopcode reads the
repository it is launched from, so the directory matters.

```bash
cd path/to/your-project
woopcode
```

### Headless

`--prompt` runs one turn without the interface and exits. There is nobody to
answer an approval prompt, so tool edits and shell commands are approved
automatically.

```bash
woopcode --prompt "summarise the auth flow"
```

`--no-auto-approve` inverts that: edits and commands are rejected rather than
approved. The agent can read and reason, and anything that would change the
checkout is refused.

```bash
woopcode --prompt "summarise the auth flow" --no-auto-approve
```

:::warning
Plain `--prompt` approves everything, including shell commands, regardless of
the approval mode saved in your config. Use `--no-auto-approve` anywhere the
checkout matters — CI in particular.
:::

## `woopcode models`

```bash
woopcode models [-m <model-id>]
```

Prints the model table. With `-m, --model <model-id>`, prints one row.

```bash
woopcode models --model gemini-3.6-flash
```

An unknown id prints `Model "<id>" not found.` and exits without error.

## `woopcode providers`

| Subcommand | Description |
| --- | --- |
| `list` | Every provider with its default and auth status |
| `login` | Store an API key and make that provider the default |
| `logout` | Remove a stored API key |
| `set` | Change the default provider without touching keys |

`login` takes the provider and the key:

```bash
woopcode providers login --provider google --api-key "$GOOGLE_API_KEY"
```

| Option | Applies to | Description |
| --- | --- | --- |
| `-p, --provider <name>` | all four | Which provider to act on |
| `-a, --api-key <key>` | `login` | The key to store |

Google Gemini is the only implemented provider. `openai` and `anthropic` appear
in `providers list` so you can see they are planned, but selecting one will not
give you a working session.

## Exit codes

Woopcode exits `0` on success and non-zero when a command fails to parse. A
turn that the agent could not complete is reported in the output, not in the
exit code.

## See also

- [Slash commands](/docs/reference/slash-commands) — the commands you type
  inside a session
- [Configuration](/docs/reference/configuration) — where these settings are
  written
