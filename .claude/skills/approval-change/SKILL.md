---
name: approval-change
description: Use when changing how a shell command is judged or gated — anything under runtime/approval/, or the classification tables in runtime/toolEffects.ts. Fail-closed is the invariant, every change needs a fixture in both directions, and both operating systems' path semantics have to be reasoned about. Triggers on "approval mode", "auto-approve", "this command shouldn't need confirmation", "the agent keeps asking", or any edit to the classifier or the effects table.
---

# Changing approval or classification

This is the code that decides whether something with write access to a
repository gets to run without asking. Treat a change here as security-relevant,
because it is.

## The invariants

**Unrecognised means destructive.** A command the classifier does not know is
treated as dangerous, never as safe. Failing closed is the only defensible
default. A change that makes an unknown command permissive is the change to
refuse — say so rather than implementing it.

**Never fall back to permissive.** A malformed approval mode falls back to the
default. Config failures never block startup, and never open the gate either.

**The split is deliberate.** `runtime/approval/classifier.ts` decides how risky a
command is. `runtime/approval/policy.ts` decides whether that risk needs asking.
Keep the judgement in the first and the decision in the second. Adding an
approval mode is one entry in a table in `runtime/approval/approval-mode.ts`, not
a new branch through the policy.

**Classify by what a command does, not by what it is called.** This is the
lesson `runtime/toolEffects.ts` was rewritten around, after a benchmark run
showed the agent doing most of its real editing through `sed -i`, `cat >> file`
and `printf ... > file` rather than through the write tools. Name-only
classification recorded those edits as verification, which is the opposite of
what they are.

Concretely, the distinctions that already exist and must survive your change:

- `sed -i` rewrites a file; `sed 's/a/b/' f` only prints. The flag is the signal,
  not the program.
- Quoted runs are stripped before matching, so `gcc` inside a replacement string
  is data, not a compile.
- `2>&1` and `>&2` point at a stream, not a file, and are the usual false
  positive for a bare `>`.
- A command can both write and verify — `sed -i s/x/y/ f.c && make` — and the
  order matters, so both flags are reported rather than one winning.
- An inline script (`python -c`, `node -e`) that opens a file for writing is a
  real edit path here, not an edge case.

## Fixtures, in both directions

Every change needs two: a command that must now be caught, and a nearby one that
must still not be. A rule that only has positive fixtures is a rule that will be
widened by the next person until it catches everything.

They go in `runtime/approval/classifier.test.ts`,
`runtime/approval/policy.test.ts`, `runtime/approval/paths.test.ts` or
`packages/tests/runtime/commandEffects.test.ts`, whichever owns the layer you
touched.

## Both operating systems

CI runs the suite on ubuntu **and** macOS specifically because the approval
classifier and the config loader are built on path semantics, and macOS differs
on case sensitivity and on where a temporary directory lives. That matrix has
already caught a bug that appeared on only one of them.

So when a change involves paths, reason about both before pushing, and put the
case in `runtime/approval/paths.test.ts`. A local green run is one half of the
evidence.

## Verify

```bash
bun test runtime/approval
bun test packages/tests/runtime/commandEffects.test.ts
bun run verify --all
```

Then the check no suite can make for you: state, in the commit body, which
command the change newly permits and why that is safe. If you cannot name it,
the change is broader than you think.
