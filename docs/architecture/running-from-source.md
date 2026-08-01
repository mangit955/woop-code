---
title: Running from source
type: guide
summary: Clone it, run it, test it, and work on the docs site.
prerequisites: []
related:
  - /docs/architecture/how-it-works
  - /docs/architecture/adding-a-tool
since: 0.6.0
---

# Running from source

## Set up

```bash
git clone https://github.com/mangit955/woop-code.git
cd woop-code
bun install
```

Bun 1.0 or later, and a Google Gemini API key.

## Run it

```bash
bun run start
```

That is `bun ./cli.ts`. On first launch it walks you through the setup flow, the
same as the published package. Your key lands in the normal config directory,
so a source checkout and an installed copy share it.

To run against a different project, launch from there:

```bash
cd ../some-other-project
bun /path/to/woop-code/cli.ts
```

## Test it

```bash
bun test
```

`bun run test` runs the suite *and* `tsc --noEmit`, which is what CI does and
what you should run before opening a pull request.

```bash
bun test --watch
```

Tests live beside the code they cover and in `packages/tests/`.

:::tip
`./run-tests.sh` runs only the runtime, tools, and property suites. It is the
fast loop when you are working on the agent rather than the interface.
:::

## The site and docs

```bash
bun run site
```

Serves the landing page and the documentation at `http://localhost:3000`.

| Script | What it does |
| --- | --- |
| `bun run site` | Dev server, with hot reload |
| `bun run site:build` | Static landing page into `site/dist` |
| `bun run docs:extract` | Regenerate the tool/command/mode data the docs read |
| `bun run docs:tokens` | Regenerate the dark palette from the TUI theme |
| `bun run docs:lint` | Check pages against the docs design system |
| `bun run docs:check` | Both of the above, as CI runs them |

Documentation pages are markdown in `docs/`, rendered on request — a prose edit
is one reload away with no build step.

:::warning
Two things do not hot-reload. **CSS edits need a server restart** — Bun's dev
server caches the bundled stylesheet. **Changes to modules imported by
`site/server.ts`** — including the docs renderer — also need a restart, or you
will be reading stale output and debugging a fix that already worked.
:::

## Before a pull request

```bash
bun run test
bun run docs:check
```

Run `docs:extract` if you added or changed a tool, slash command, or approval
mode. `docs:check` fails when the code has moved and that data has not, which
is the whole reason it exists.

## When it does not work

**`bun: command not found`** — Install Bun, then open a new terminal.

**Tests fail on a clean clone** — Run `bun install` first; the suite needs dev
dependencies.

**The site shows stale content** — Restart the server. See the warning above.

**`surface.json is out of date`** — Run `bun run docs:extract` and commit the
result.

## Next

- [Adding a tool](/docs/architecture/adding-a-tool)
- [How it works](/docs/architecture/how-it-works)
