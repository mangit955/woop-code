#!/usr/bin/env bun
/**
 * Removes agent worktrees under `.claude/worktrees/` that have nothing left in
 * them, and runs on `SessionStart` (see `.claude/settings.json`).
 *
 * Claude Code creates one of these per `isolation: "worktree"` subagent and is
 * meant to clean it up when the copy comes back unchanged. One survived and sat
 * at 276MB — 195MB of it a second `node_modules`, 74MB a second `site/` — for a
 * branch that had already been merged. Nothing points at these directories
 * (`.gitignore:42` keeps them out of the repo entirely), so the only thing that
 * would ever notice is `du`.
 *
 * The bar for removing one is deliberately high, because the alternative is
 * deleting work that only exists there:
 *
 *   - the working tree is clean, tracked *and* untracked (`--porcelain` with
 *     `-unormal`, so a stray file someone dropped in counts as work), and
 *   - the branch it is on has no commits the default branch lacks.
 *
 * Anything else is left alone and reported, which is the case worth seeing: a
 * worktree with real work in it is not clutter, it is something you forgot.
 *
 * `git worktree prune` is not this. It only forgets administrative files whose
 * directory has already been deleted by hand — the 276MB directory is exactly
 * the case it walks past.
 */

import { $ } from "bun";

const WORKTREE_ROOT = ".claude/worktrees";

type Worktree = { path: string; branch: string | null };

/** `git worktree list --porcelain` as records; the first is always the main checkout. */
async function listWorktrees(): Promise<Worktree[]> {
  const out = await $`git worktree list --porcelain`.text();
  const worktrees: Worktree[] = [];
  for (const block of out.trim().split("\n\n")) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    const ref = block.match(/^branch (.+)$/m)?.[1] ?? null;
    worktrees.push({ path, branch: ref?.replace(/^refs\/heads\//, "") ?? null });
  }
  return worktrees;
}

async function defaultBranch(): Promise<string> {
  for (const candidate of ["main", "master"]) {
    if (await $`git show-ref --verify --quiet refs/heads/${candidate}`.nothrow().then((r) => r.exitCode === 0)) {
      return candidate;
    }
  }
  return "HEAD";
}

async function isClean(path: string): Promise<boolean> {
  const status = await $`git -C ${path} status --porcelain -unormal`.nothrow().text();
  return status.trim() === "";
}

/** True when `branch` holds no commit that `base` does not already have. */
async function isMerged(branch: string, base: string): Promise<boolean> {
  const ahead = await $`git rev-list --count ${base}..${branch}`.nothrow().text();
  return ahead.trim() === "0";
}

const base = await defaultBranch();
const [, ...agentWorktrees] = await listWorktrees();
const kept: string[] = [];

for (const { path, branch } of agentWorktrees) {
  if (!path.includes(WORKTREE_ROOT)) continue;

  const reason = !(await isClean(path))
    ? "uncommitted changes"
    : branch && !(await isMerged(branch, base))
      ? `commits not in ${base}`
      : null;

  if (reason) {
    kept.push(`${path} (${reason})`);
    continue;
  }

  const removed = await $`git worktree remove ${path}`.nothrow();
  if (removed.exitCode !== 0) {
    kept.push(`${path} (git declined to remove it)`);
    continue;
  }
  console.log(`pruned stale agent worktree: ${path}`);
}

if (kept.length > 0) {
  console.log(`agent worktrees left in place:\n  ${kept.join("\n  ")}`);
}
