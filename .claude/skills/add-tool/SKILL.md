---
name: add-tool
description: Use when adding a new tool to tools/, or changing an existing tool's name, parameters, description, or output shape. Covers the registry, the effects table, the generated docs surface, and the invariants a tool must hold (truncation, workspace containment, approval, AbortSignal, model-facing errors). Triggers on "add a tool", "new tool", "the agent should be able to ...", or any edit under tools/.
---

# Adding or changing a tool

A tool is `{ name, description, parameters, execute(args, signal) }` — the `Tool`
interface in `config/types.ts`.

The returned string is what the model sees. It is interface, not a log line.

## The sequence

Do all of it. Steps two through four are the ones that get skipped, and only the
last of them fails a check.

1. **Write the tool** in `tools/`. Copy `tools/readFile.ts` — it is the one that
   demonstrates every invariant below.
2. **Append it to `toolRegistry`** in `tools/index.ts`.
3. **Add its effect to `TOOL_EFFECTS`** in `runtime/toolEffects.ts` — `read`,
   `write`, `shell` or `ask`. A missing entry reads as `unclassified`, and both
   the runtime and `site/scripts/extract.ts` consume that table.
4. **Regenerate the docs surface**: `bun run docs:extract`, then commit the
   updated `site/src/docs/surface.json`. Nothing in `docs/` names a tool in
   prose, so the pages pick it up on their own.
5. **Add an integration test** in `packages/tests/tools/`, against real files in
   a temporary directory. `packages/tests/tools/readFile.integration.test.ts` is
   the pattern. Read the `bun-test` skill before writing it.

A new tool is swept by `packages/tests/contracts/tool.contract.test.ts`
automatically once it is in the registry — nothing to add there, but expect it to
hold you to the contract.

## Invariants

**Bound the output, and say you did.** Results are trimmed to `MAX_TOOL_RESULT`
in `runtime/loop.ts` before reaching the model, keeping both ends. That is a
backstop, not a plan: truncate deliberately at a limit you choose and append a
notice saying what was dropped and how to get the rest. `tools/readFile.ts` does
this twice — once for a whole file, once for a requested range.

**Route every path through `resolveWorkspacePath`** (`tools/workspace.ts`). It
resolves symlinks before the containment check, which a string comparison does
not. Never build the check yourself.

**A tool that writes raises an approval request; it does not write.**
`tools/editFile.ts` pushes a `PendingEdit` into the UI store and waits. Writing
directly bypasses the diff review the product rests on.

**Write errors for the model, not for a log.** `File <path> does not exist`, not
`ENOENT`. Tool errors are returned to the agent as results rather than thrown out
of the turn, so the message is what it uses to correct itself and retry. Name the
path it passed, and say what to do instead where there is an obvious next move —
`Cannot read <path>: it is a directory. Use list_files to see directory contents.`

**Throw on missing required arguments before doing any work.** No network call,
no filesystem touch, no UI store write until the arguments are validated. The
contract sweep calls `execute({})` on every registered tool.

**Take the `AbortSignal` and honour it.** The signature is
`execute(args, signal)`; the signal is aborted when the user cancels the turn.
Pass it to `fetch`, to the subprocess, to whatever can be interrupted —
`tools/terminal.ts`, `tools/webFetch.ts` and `tools/runTests.ts` all do.

**Bun, not Node.** `Bun.file` over `readFile`/`writeFile`, `` Bun.$ `` over
`child_process`. The gate rejects the Node forms on added lines. `node:path` and
`existsSync` are fine and used throughout.

## Verify

```bash
bun run verify --all
```

That is tsc, the suite, and `docs:check` — and `docs:check` is the one that
catches a `site/src/docs/surface.json` you forgot to regenerate.

A missing `TOOL_EFFECTS` entry does not fail anything. `bun run docs:extract`
warns about it by name and writes the tool into the surface as `unclassified`,
so read what extract prints rather than only its exit code.

The contract sweep in `packages/tests/contracts/tool.contract.test.ts` picks up
the new tool the moment it is in `toolRegistry` — there is nothing to add
there, but it will hold you to the invariants above.

Then exercise the tool for real, which no check above does:

```bash
bun cli.ts --prompt "<a prompt that should make the agent reach for the new tool>"
```
