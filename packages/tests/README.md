# Testing

```bash
bun test                       # everything
bun test packages/tests/tools  # one directory
bun test --watch runtime/      # while working
bun test path/to/one.test.ts   # one file
```

Tests live next to the code in `runtime/`, `tui/`, `config/` and `commands/`, and
in `packages/tests/` when they need fixtures or cross several modules. Both are
picked up by a bare `bun test`.

This file describes what the suite is for and the ways it can mislead you. It
deliberately holds no test counts, file inventories or pass/fail status: those
are printed by every run, and a copy of them here is wrong the moment someone
adds a test. `bun run docs:lint` enforces that.

## What CI gates on

Three checks, on every push and pull request — see `.github/workflows/ci.yml`.

| Check | Where |
|---|---|
| `bun test` | ubuntu and macOS |
| `bunx tsc --noEmit` | ubuntu |
| `bun run docs:check` | ubuntu |

Both operating systems run, because the approval classifier and the config
loader are built on path semantics and macOS differs from Linux on case
sensitivity and on where a temporary directory lives. That matrix has already
caught a bug that only appeared on one of them.

## Real APIs, not mocked ones

Bun's global is readonly, so `globalThis.Bun = { … }` throws. That is a
constraint worth being glad about: the tools are tested against real files in a
temporary directory instead of against a mock that can drift from the behaviour
it stands in for.

```ts
const file = join(tmpdir(), `test-${crypto.randomUUID()}.txt`);
await writeFileTool.execute({ path: file, content: "new" });
expect(await Bun.file(file).text()).toBe("new");
```

Only two things are faked: the provider (no network in a test run) and the
approval prompt (no human). Everything else is the real thing.

## Module mocks are global, and that is the trap

`mock.module` is registered for the **entire run**, not for the file that calls
it, and it cannot be taken back:

- **Restoring it in `afterAll` does not work.** Bun binds a static import during
  the load phase, long before any hook runs, so re-registering later rebinds
  nothing.
- **A mock must therefore be inert outside its own file.** Gate it on a flag set
  in `beforeAll` and cleared in `afterAll`, and delegate to the real
  implementation the rest of the time. `packages/tests/e2e/` shows the shape.
- **Never hand out a fresh object per test.** A module captures what it imported
  the first time, so replacing the object each `beforeEach` leaves that module
  holding a store no later test can patch. Register once against a stable object
  and reset its methods in place.
- **Stub the whole module, not part of it.** Spread the real one and override
  only what you need, or unrelated exports vanish for every other file.

This is not hypothetical. The suite once reported a full green run while two
persistence tests were quietly asserting against another file's in-memory stub;
they failed the moment they ran alone. A green run is only meaningful if it is
green for the right reasons.

## Checking that the suite is honest

Order dependence hides in a passing run. Two cheap ways to expose it:

```bash
bun test $(git ls-files '*.test.ts' '*.test.tsx' | sort -r)   # reversed order
for f in $(git ls-files '*.test.ts' '*.test.tsx'); do bun test "$f" || echo "BROKEN $f"; done
```

The second is the stronger one — every file on its own, no other file's mocks in
memory. CI runs the same sweep automatically whenever the suite fails, so a hang
names the file it hung in rather than cancelling the job in silence.

## The environment a test runs in

- **`CI=true` changes rendering.** Ink writes only its final frame when it
  detects CI, so a test asserting on frames must pass `interactive: true` or it
  will read an empty string on a runner and pass locally forever.
- **Config must be redirected.** Anything touching config sets
  `XDG_CONFIG_HOME` to a temporary directory first, so a test run never reads or
  writes the developer's real `~/.config/woopcode`.
- **Time and randomness belong in the arguments.** A test that waits on a real
  clock is a test that fails on a loaded runner.

## Where things are

| Directory | Holds |
|---|---|
| `runtime/` | The agent loop and controller: streaming, cancellation, invariants, robustness |
| `tools/` | One file per tool, against real files in a temporary directory |
| `e2e/` | Whole workflows through the real controller, with only the provider faked |
| `contracts/` | The shapes a tool and a provider must satisfy, applied to every implementation |
| `property/` | Generated inputs via fast-check, for the cases nobody thinks to write down |
| `goldens/` | Recorded outputs, so a formatting change has to be deliberate |
| `performance/`, `bench/` | Timing, kept out of the correctness suite |
| `shared/` | Factories, fakes and helpers — prefer these to hand-rolling a fixture |

## Adding a test

Cover the happy path first, then the cases that actually break software here:
unicode and emoji, empty and whitespace-only input, large files, missing paths
and permissions, approval accepted and rejected, and cancellation partway
through. When a bug is fixed, the regression test belongs in the same commit —
and it should fail without the fix. Check that it does.
