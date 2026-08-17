---
title: Sandboxed execution
type: guide
summary: Running shell commands in a disposable virtual machine instead of on your laptop, what still comes back to disk, and what the sandbox does not protect.
prerequisites:
  - /docs/guides/approval-modes
related:
  - /docs/reference/configuration
  - /docs/reference/slash-commands
since: 1.1.0
---

# Sandboxed execution

Approval modes decide *whether* a command runs. Sandboxing decides *where*. With
it on, every shell command Woopcode runs goes into a fresh virtual machine
instead of onto your laptop — so a command that formats the disk, installs a
global package or reaches for `~/.ssh` does that to a machine which is thrown
away.

It is off by default and needs an [E2B](https://e2b.dev) key:

```bash
export E2B_API_KEY=e2b_...
woopcode --sandbox
```

Or from inside a session:

```text
/sandbox on
```

The preference is saved, so the next session starts sandboxed too. `/sandbox
off` is the way back; `--sandbox` can only turn it *on*, never off, so a flag
left out of a command line cannot silently drop the boundary someone chose.

Turning it on does not create anything. The virtual machine is created by the
first command that needs one, so enabling it and then having a conversation that
only reads files costs nothing.

## Your files stay on your machine

This is the part worth understanding before you turn it on, because it is not
what "sandbox" usually implies.

**Local disk stays the source of truth.** The sandbox is a cache, not a new home
for your work. Your editor, `git`, and the diff review all carry on pointing at
the real repository, and file edits by the agent are written locally as they
always were — they never go near the sandbox.

Around each command:

```terminal
  local disk  ──push──▶  sandbox     your files, as they are now
                         run         the command
  local disk  ◀──pull──  sandbox     only what the command wrote
```

Each command is a transaction against the tree it was handed, which is what lets
the pull ask *what did this command do to those exact files* rather than the
much weaker "what changed lately" — a question that cannot tell the command's
work from yours.

If you edited a file locally while the command was running, **you win.** The
sandbox's version is written beside yours rather than over it:

```terminal
src/parser.ts was changed locally while the command ran, so it was
left as it is; the sandbox's version is at src/parser.ts.sandbox.
```

Nothing is merged and nothing you wrote is overwritten.

## What gets sent

Not everything in the directory. The transmitted set is what `git` lists as
tracked or untracked-but-not-ignored, and then three things are taken out of it:

| Held back | Why |
| --- | --- |
| Ignored files | `.gitignore` is honoured, so `node_modules/` and build output stay put |
| Anything that looks like a credential | An unconditional denylist, applied even to files git *does* list — a force-added `.env` is tracked, and only this stops it |
| Files over the size cap | Default 1MB, so a repository with committed media does not pay to upload it every session |

:::note
Symlinks are never sent. A symlinked file is simply invisible inside the
sandbox — a limitation rather than a defect, and the alternative was worse: a
pushed symlink is absent from every listing that comes back, which is exactly
how a deletion is recognised, so it was being deleted from the working tree.
:::

`/sandbox status` tells you what the split looked like:

```terminal title="woopcode — /sandbox status"
Sandbox: on (iw3f9k2mzq0xv8n5)
412 files sent, 7 held back

  /sandbox off  run commands on this machine again
```

## What it changes about approval

A sandboxed command is judged by where it will run as well as by what it does.
Machine-level work and writes outside the repository are lowered, because
neither survives a machine that is discarded — so `sudo apt-get install`, which
would stop and ask on your laptop, just runs.

**Destructive commands still ask.** `rm -rf`, `git reset --hard` and
`git clean` are gated exactly as before, and this is deliberate rather than an
oversight: the pull carries the sandbox's deletions back onto local disk, so a
sandboxed `rm -rf` costs you real uncommitted work. An unrecognised command
lives at that level too, by the same fail-closed rule the classifier follows
everywhere.

So the accurate summary is that sandboxing widens what runs unattended at the
*system* end and changes nothing at the destructive end. It is a containment
boundary for the machine, not permission to destroy the repository.

## Network and secrets

Egress is open by default. To cut it:

```bash
woopcode --sandbox --sandbox-network none
```

No environment variable is forwarded unless you name it:

```bash
export WOOPCODE_SANDBOX_ENV=GITHUB_TOKEN,NPM_TOKEN
```

Provider keys, `WOOPCODE_API_KEY` and `E2B_API_KEY` are refused **even when
named explicitly**, and Woopcode says so rather than dropping them quietly. The
allowlist exists so a build can reach a private registry; it is not a way to
hand the sandbox the keys to the agent itself.

## What it does not protect

- **Files the agent edits.** `edit_file` writes locally, gated by the diff
  review. The sandbox governs shell commands.
- **Anything a command deletes**, once the pull brings that deletion back.
  Commit before a risky run.
- **Your provider bill.** The model is unaffected by any of this.

## When it does not work

**`/sandbox on` says there is nowhere to run** — `E2B_API_KEY` is not set.
Nothing falls back to running locally, by design.

**A command fails and the sandbox is blamed** — Check whether the command itself
failed. A non-zero exit is a result, not a sandbox error; a red test suite comes
back as a red test suite.

**The first command is slow** — `bun` is not in E2B's base image, so a
repository with a `bun.lock` triggers a one-off install. `node`, `npm`,
`python3`, `git`, `gcc`, `make`, `curl` and `tar` are already there. After that,
a command round trip costs roughly 300ms on top of the command.

**A server started in the sandbox is unreachable at localhost** — It would be.
Give `port` to `process_start` and use the URL it hands back.

**Files named `<something>.sandbox` appeared** — Those are conflicts: you and
the command both changed the same file. Yours is the one still in place.

## Next

- [Approval modes](/docs/guides/approval-modes) — the other half of what decides
  whether a command runs.
- [Configuration](/docs/reference/configuration) — every sandbox environment
  variable, with defaults.
