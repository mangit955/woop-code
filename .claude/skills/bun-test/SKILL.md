---
name: bun-test
description: Use when writing or changing any test file in this repository. Covers the module-mock trap that once made the whole suite green for the wrong reason, testing against real files instead of mocks, the environment a test runs in, and the sweep that proves the suite is honest. Triggers on any edit to a *.test.ts or *.test.tsx file, "add a test", "write a regression test", or a failing suite that passes in isolation.
---

# Writing a test here

`packages/tests/README.md` is the source. This is the part that bites.

## Real APIs, not mocks

Bun's global is readonly, so there is no faking `Bun.file`. Test tools against
real files in a temporary directory:

```ts
const file = join(tmpdir(), `test-${crypto.randomUUID()}.txt`);
await writeFileTool.execute({ path: file, content: "new" });
expect(await Bun.file(file).text()).toBe("new");
```

**Note the UUID.** `Date.now()` has millisecond resolution, so two test processes
build the same path, `mkdirSync({ recursive: true })` accepts the existing
directory silently, and the first `afterEach` deletes the other run's files
mid-test — a failure that only appears when something else is touching the tree.
`glob.integration.test.ts` had it.

A fixture a *tool* will resolve has to live inside the workspace, not `tmpdir()`:
every file tool routes through `resolveWorkspacePath` and refuses anything
outside. The snippet above works because `writeFileTool` is handed the path.

Only two things are faked in this suite: the provider, because a test run makes
no network calls, and the approval prompt, because there is no human. Everything
else is the real thing. Prefer the factories and fakes in
`packages/tests/shared/` to hand-rolling a fixture.

## Module mocks are global, and that is the trap

`mock.module` is registered for the **entire run**, not for the file that calls
it, and it cannot be taken back. Restoring it in `afterAll` does nothing — Bun
binds a static import during the load phase, long before any hook runs.

This is not hypothetical. The suite once reported a fully green run while two
persistence tests were quietly asserting against another file's in-memory stub.
They failed the moment they ran alone.

So a mock must be inert outside its own file. Four rules, all four required.
`packages/tests/e2e/persistence.e2e.test.ts` is the worked example:

1. **Capture the real module before registering**, at the top level, and hold the
   real function as a *direct reference*. Reading it off the namespace at call
   time resolves back to the mock and recurses.
2. **Gate on a flag** set in `beforeAll` and cleared in `afterAll`. Delegate to
   the real implementation whenever the flag is off.
3. **Register once against a stable object.** A module captures what it imported
   the first time, so handing out a fresh object each `beforeEach` leaves that
   module holding a store no later test can patch. Reset methods in place.
4. **Stub the whole module.** Spread the real one and override only what you
   need, or unrelated exports vanish for every other file in the run.

## The environment a test runs in

- **`CI=true` changes rendering.** Ink writes only its final frame when it
  detects CI, so a test asserting on frames must pass `interactive: true` or it
  reads an empty string on a runner and passes locally forever.
- **Redirect config, and put it back in `afterAll` only.** Anything touching
  config sets `XDG_CONFIG_HOME` to a temporary directory first, so a run never
  reads or writes the developer's real config. Restoring it in `afterEach` defeats
  the whole thing: `approval.integration.test.ts` did `delete
  process.env.XDG_CONFIG_HOME` per test, so on any machine where that variable was
  not already set the redirect was gone after the *first* test and every later one
  wrote the real `~/.config/woopcode/providers.json` — provable from its mtime.
- **Time and randomness belong in the arguments.** A test that waits on a real
  clock is a test that fails on a loaded runner — that is what broke the
  cancellation test on macOS CI.

## What to cover

Happy path first, then the cases that actually break software here: unicode and
emoji, empty and whitespace-only input, large files, missing paths and
permissions, approval accepted and rejected, cancellation partway through.

When you fix a bug, the regression test belongs in the same commit — and it must
fail without the fix. Check that it does, by reverting the fix and watching it
go red. A regression test that never failed is a test of nothing.

Never silence a test to get a green run. An added `.only` or `.skip` is rejected
by the gate.

Do not add test counts, file inventories or pass/fail status to
`packages/tests/README.md`. Every run prints them, a copy goes stale, and
`bun run docs:lint` fails on it.

## Verify

A green run is not the check. Order dependence hides in one:

```bash
bun test $(git ls-files '*.test.ts' '*.test.tsx' | sort -r)
```

The stronger sweep is every file on its own, with no other file's mocks in
memory:

```bash
for f in $(git ls-files '*.test.ts' '*.test.tsx'); do bun test "$f" || echo "BROKEN $f"; done
```

Neither sweep catches a test that shares state with *another run*. Three bugs got
through all of the above and only failed when something else touched the tree at
the same moment. Run several suites at once to reproduce that class:

```bash
for i in 1 2 3 4; do (bun test > /tmp/load-$i.txt 2>&1 &); done
sleep 90; grep -lE " fail" /tmp/load-*.txt
```

Then `bun run verify --all`.
