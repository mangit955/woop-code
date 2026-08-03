---
description: Branch, verify, commit, push and open a draft PR for the current work
argument-hint: [hint about the change or the branch name]
allowed-tools: Bash(git *), Bash(gh *), Bash(bun run verify*), Bash(bun run docs:*), Read, Grep, Write
---

Take whatever is in the working tree and turn it into a draft pull request
against `main`, following this repository's conventions.

`$ARGUMENTS` is an optional hint about what the change is or what to call the
branch. Treat it as a steer, not a spec — the diff is the source of truth.

## 1. Read the state

Run these and read all of them before doing anything:

```bash
git status --short
git branch --show-current
git fetch origin main --quiet && git log origin/main..HEAD --oneline
git diff HEAD          # staged and unstaged, against the last commit
git status --porcelain # untracked files show as ??
```

Read the actual content of the changed files where the diff alone doesn't
explain the intent. You are about to write a PR body that claims to know why
this change exists; go and find out.

If the tree is clean **and** nothing is ahead of `origin/main`, stop and say
there is nothing to ship.

## 2. Branch if needed

If the current branch is `main`, create a branch and move the work onto it
before committing. Never commit to `main`.

The name is `<type>/<slug>`, matching what is already there
(`feat/read-file-range`, `fix/compaction-off-by-default`,
`chore/validation-gate`, `test/replay-baseline-corpus`):

- `type` is the conventional type the diff implies — `feat`, `fix`, `chore`,
  `test`, `docs`.
- `slug` is two to four kebab-case words naming the change, not the files.

```bash
git checkout -b <type>/<slug>
```

If already on a branch other than `main`, keep it.

## 3. Verify before committing

```bash
bun run verify
```

This is the gate. It picks the checks the change owes from the paths it touched
and reads the lines the change adds; `verify.ts`'s header documents every rule.

**If it fails, stop.** Report its output verbatim and fix the cause, or hand it
back. Never pass `--no-verify` or `-n` to `git commit`, and never edit a test to
get past it. The gate is bound twice — `.githooks/pre-commit` and a `PreToolUse`
hook in `.claude/settings.json` — because walking past it is the failure mode it
exists to prevent.

Two things `verify` will tell you about but you should anticipate:

- A change under `tools/`, `commands/slash/`, `runtime/` or `config/version.ts`
  stales the generated docs surface. Run `bun run docs:extract` and commit the
  updated `site/src/docs/surface.json` in the same commit.
- A `.ts`/`.tsx` change owes `tsc --noEmit` and the full `bun test`; a `.md`
  change owes the docs lint. Both are inside `verify`.

## 4. Commit

Stage the work and commit. Anything already committed on this branch is left
alone — only commit what is still uncommitted.

The subject must be conventional (`.githooks/commit-msg` rejects anything
else): `<type>(<scope>): <imperative summary>`, lowercase, no trailing period.
Scopes in use: `tools`, `runtime`, `provider`, `tests`, `ci`, `replay`, `docs`.

The body says why, not what — the diff already says what. End it with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Write the message to a temp file and use `git commit -F <file>`, so backticks
and newlines survive.

## 5. Push

```bash
git push -u origin <branch>
```

## 6. Open a draft PR

Check first whether the branch already has one:

```bash
gh pr view --json number,url,isDraft
```

If it does, the push has already updated it — report that URL and stop. Do not
try to create a second one.

Otherwise:

```bash
gh pr create --draft --base main --title "<conventional title>" --body-file <tmp>
```

Always `--draft`. Always `--body-file`, never `--body` — these bodies carry
backticks, tables and blank lines that shell quoting mangles.

The title is the commit subject when there is one commit; when there are
several, a conventional subject covering the set.

### The body

Match the register to the size of the change. Both forms are in the merged PRs;
read one before writing if unsure.

**Small, single-purpose change** — plain narrative paragraphs, no headings
(PRs #36 and #37 are the models). What was wrong or missing, what changed, why
that shape and not the obvious alternative, what was verified and how. Prose,
not bullets.

**Larger or multi-part change** — `## Why`, `## What`, `## Verified` headings
(PR #38 is the model), with a table when there are rules or cases worth
enumerating.

Either way:

- Lead with the problem. Someone reading in six months needs the reason before
  the mechanism.
- Name the tradeoff you made and the alternative you rejected, if there was one.
- **Verified means verified.** List the checks that actually ran and what they
  actually printed. If something was skipped or could not be tested, say that
  plainly rather than writing a sentence that implies a green run.
- End with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## 7. Report

Tell the user, briefly:

- the branch
- the commit subject
- which checks ran and that they passed
- the PR URL

If anything was skipped or left out, say so here too.
