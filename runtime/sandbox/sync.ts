/**
 * Keeping local disk and a sandbox in agreement.
 *
 * One invariant carries the whole design: **the sandbox is a cache.** Local disk
 * is authoritative for what goes in; the sandbox is authoritative only for what
 * a command just wrote. Nothing is ever merged, and no local change a person
 * made is ever overwritten.
 *
 * That last part is the reason for the input snapshot. Every command is a
 * transaction against a tree we put there ourselves, so afterwards the question
 * is not "what changed recently" — which cannot distinguish the command's work
 * from the user's — but "what did this command do to the exact tree I handed
 * it", which has one answer. When the two disagree, the user wins and the
 * sandbox's version is set beside it rather than over it.
 */

import path from "node:path";
import { tmpdir } from "node:os";
import { rename, unlink, mkdir, rm } from "node:fs/promises";
import { IGNORED_DIRECTORIES } from "../../tools/scan";
import { resolveWorkspacePath } from "../../tools/workspace";
import {
  buildManifest,
  diffManifests,
  parseSha256Sums,
  type Manifest,
} from "./manifest";
import { isSecretShaped, transmittableSet } from "./transmittable";
import { REMOTE_WORKSPACE, TAR_ENV } from "./settings";
import type { SandboxClient } from "./session";

/**
 * Printed after the remote listing, so a listing that did not finish can be
 * told apart from a workspace with nothing in it.
 *
 * Our own command rather than the user's, so nothing else can emit it.
 */
export const MANIFEST_SENTINEL = "__woopcode_manifest_end__";

/** How many files a single pull will write back. */
export const MAX_PULL_FILES = 500;

/** How many bytes a single pull will bring back, measured on the archive. */
export const MAX_PULL_BYTES = 32 * 1024 * 1024;

/** The pull was too large to apply, so none of it was. */
export class PullTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullTooLargeError";
  }
}

export type RefusalReason =
  | "secret"
  | "ignored"
  | "outside-workspace"
  | "over-file-cap"
  | "over-byte-cap"
  | "manifest-unavailable";

export interface Conflict {
  path: string;
  /** Where the sandbox's version was put, for a modification. */
  savedAs?: string;
  kind: "modified" | "deleted";
}

export interface SyncReport {
  pushed: string[];
  removedRemotely: string[];
  written: string[];
  deleted: string[];
  conflicts: Conflict[];
  refused: { path: string; reason: RefusalReason }[];
}

export function emptyReport(): SyncReport {
  return {
    pushed: [],
    removedRemotely: [],
    written: [],
    deleted: [],
    conflicts: [],
    refused: [],
  };
}

/**
 * The directories never hashed on the remote side.
 *
 * The same list `list_files` prunes, for the same reason plus one more: the
 * sandbox accumulates `node_modules` and build output that a local
 * `git ls-files` would never have offered, and hashing thirty thousand
 * dependency files after every command would dominate the cost of running one.
 * They stay in the sandbox by design — the next command is the same sandbox.
 */
function remotePruneExpression(): string {
  return [...IGNORED_DIRECTORIES]
    .map((directory) => `-path './${directory}' -prune -o`)
    .join(" ");
}

/**
 * Hashes the sandbox's copy of the workspace.
 *
 * Everything, not just what looks recent. `find -newer` would be cheaper — 309ms
 * against 664ms, measured — but it answers a question about timestamps, and any
 * write that preserves mtime slips past it: `cp -p`, `tar -x`, `touch -d`, a
 * restored artifact. A missed file is precisely the silent divergence this
 * module exists to prevent, so the cheaper filter is not worth its blind spot.
 */
export async function remoteManifest(client: SandboxClient): Promise<Manifest | null> {
  const command =
    `cd ${REMOTE_WORKSPACE} && ` +
    `find . ${remotePruneExpression()} -type f -print0 2>/dev/null ` +
    `| xargs -0 -r sha256sum 2>/dev/null; ` +
    `echo '${MANIFEST_SENTINEL}'`;

  const result = (await client.commands.run(command)) as { stdout?: unknown };
  const stdout = typeof result.stdout === "string" ? result.stdout : "";

  // Null, never an empty manifest.
  //
  // This is the most dangerous line in the module. An empty manifest is
  // indistinguishable from "every file was deleted", and the caller acts on
  // that difference by removing files from someone's working tree. A listing
  // that did not demonstrably finish — the sandbox died, `cd` failed, the
  // response was truncated — must therefore be unusable rather than empty.
  // A genuinely empty workspace still prints the sentinel.
  if (!stdout.includes(MANIFEST_SENTINEL)) return null;

  return parseSha256Sums(stdout.slice(0, stdout.lastIndexOf(MANIFEST_SENTINEL)));
}

/**
 * Brings the sandbox's copy up to date with local disk.
 *
 * Returns the manifest that was sent, which becomes the input snapshot: after
 * this, the sandbox tree provably equals it, because we are what put it there.
 */
export async function pushChanges(
  client: SandboxClient,
  workspace: string,
  remote: Manifest,
  maxFileBytes: number,
  report: SyncReport,
): Promise<Manifest> {
  const set = await transmittableSet(workspace, { maxFileBytes });
  const local = await buildManifest(workspace, set.files);

  const { changed, deleted } = diffManifests(remote, local);

  if (deleted.length > 0) {
    // Quoted individually: a path may contain spaces, and `rm -f` with an
    // unquoted list would delete the wrong things or nothing at all.
    const quoted = deleted.map((file) => `'${file.replace(/'/g, `'\\''`)}'`).join(" ");
    await client.commands.run(`cd ${REMOTE_WORKSPACE} && rm -f ${quoted}`);
    report.removedRemotely = deleted;
  }

  if (changed.length > 0) {
    await uploadFiles(client, workspace, changed);
    report.pushed = changed;
  }

  return local;
}

/** Sends a set of files as one archive. Per-file writes cost a round trip each. */
async function uploadFiles(
  client: SandboxClient,
  workspace: string,
  files: readonly string[],
): Promise<void> {
  const stamp = `${Date.now()}-${crypto.randomUUID()}`;
  const listPath = path.join(tmpdir(), `woopcode-push-${stamp}.list`);
  const tarPath = path.join(tmpdir(), `woopcode-push-${stamp}.tar.gz`);
  const remoteArchive = `/home/user/push-${stamp}.tar.gz`;

  try {
    await Bun.write(listPath, files.join("\n") + "\n");

    const tar = Bun.spawnSync({
      cmd: ["tar", "-czf", tarPath, "-T", listPath],
      cwd: workspace,
      env: TAR_ENV,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (tar.exitCode !== 0) {
      throw new Error(`tar failed: ${new TextDecoder().decode(tar.stderr).trim()}`);
    }

    await client.files.write(remoteArchive, await Bun.file(tarPath).arrayBuffer());
    await client.commands.run(
      `mkdir -p ${REMOTE_WORKSPACE} && tar -xzf ${remoteArchive} -C ${REMOTE_WORKSPACE} && rm -f ${remoteArchive}`,
    );
  } finally {
    await unlink(listPath).catch(() => {});
    await unlink(tarPath).catch(() => {});
  }
}

/**
 * The paths a pull is allowed to write, and why the rest were refused.
 *
 * A pull is a write into someone's repository, so it is filtered on the way back
 * as well as on the way out. The secret rule is the important one: without it a
 * command could plant a `.env` or an `authorized_keys` in the working tree, and
 * the sandbox would have become a way to write credentials rather than a way to
 * contain them.
 */
export async function admissiblePaths(
  workspace: string,
  candidates: readonly string[],
  report: SyncReport,
): Promise<string[]> {
  const admitted: string[] = [];

  const ignored = await gitIgnored(workspace, candidates);

  for (const candidate of candidates) {
    // Belt and braces against AppleDouble sidecars. `TAR_ENV` stops them being
    // created, but a sandbox reached by another route — a template, a setup
    // command, an archive a command unpacked — can still contain them, and they
    // are never something a user wants delivered into their repository.
    if (path.basename(candidate).startsWith("._")) {
      report.refused.push({ path: candidate, reason: "ignored" });
      continue;
    }

    if (isSecretShaped(candidate)) {
      report.refused.push({ path: candidate, reason: "secret" });
      continue;
    }
    if (ignored.has(candidate)) {
      report.refused.push({ path: candidate, reason: "ignored" });
      continue;
    }

    // The existing workspace boundary, which resolves symlinks before deciding.
    // A sandbox answering `../../etc/passwd` is refused here by the check that
    // already guards every other write in the product, against the tree being
    // synced rather than against wherever this process happens to be.
    try {
      await resolveWorkspacePath(candidate, { root: workspace });
    } catch {
      report.refused.push({ path: candidate, reason: "outside-workspace" });
      continue;
    }

    if (admitted.length >= MAX_PULL_FILES) {
      report.refused.push({ path: candidate, reason: "over-file-cap" });
      continue;
    }

    admitted.push(candidate);
  }

  return admitted;
}

/**
 * Which of these paths git would ignore.
 *
 * One process for the whole set rather than one per path. A command that leaves
 * a `debug.log` behind has not done work worth delivering, and handing it back
 * as though it had makes the real changes harder to see.
 */
async function gitIgnored(
  workspace: string,
  candidates: readonly string[],
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();

  try {
    const proc = Bun.spawn({
      cmd: ["git", "check-ignore", "--stdin"],
      cwd: workspace,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    proc.stdin.write(candidates.join("\n") + "\n");
    await proc.stdin.end();

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    return new Set(output.split("\n").map((line) => line.trim()).filter(Boolean));
  } catch {
    // Not a git repository, or no git. Nothing is ignored, which errs towards
    // delivering a file rather than silently withholding one.
    return new Set();
  }
}

/**
 * Downloads the given paths as one archive and unpacks them to a staging
 * directory outside the workspace.
 *
 * Staged rather than written in place, because the conflict rule has to compare
 * against the working tree *before* anything lands in it.
 */
export async function fetchToStaging(
  client: SandboxClient,
  files: readonly string[],
): Promise<string> {
  const stamp = `${Date.now()}-${crypto.randomUUID()}`;
  const staging = path.join(tmpdir(), `woopcode-pull-${stamp}`);
  const remoteArchive = `/home/user/pull-${stamp}.tar.gz`;
  const localArchive = path.join(tmpdir(), `woopcode-pull-${stamp}.tar.gz`);

  await mkdir(staging, { recursive: true });

  const quoted = files.map((file) => `'${file.replace(/'/g, `'\\''`)}'`).join(" ");
  await client.commands.run(
    `cd ${REMOTE_WORKSPACE} && tar -czf ${remoteArchive} ${quoted}`,
  );

  const bytes = (await client.files.read(remoteArchive, { format: "bytes" })) as Uint8Array;
  await client.commands.run(`rm -f ${remoteArchive}`);

  // Checked on the archive rather than per file, because that is the number
  // actually known before anything is written: the remote listing carries
  // hashes, not sizes. It bounds what reaches the disk, which is what the cap
  // is for. Refusing the whole pull rather than part of one keeps the working
  // tree consistent — half an applied change set is harder to reason about
  // than none of it.
  if (bytes.byteLength > MAX_PULL_BYTES) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw new PullTooLargeError(
      `the command changed ${files.length} files totalling more than ` +
        `${Math.round(MAX_PULL_BYTES / 1_048_576)}MB compressed, which is over the ` +
        `sync limit, so nothing was brought back`,
    );
  }

  await Bun.write(localArchive, bytes);

  const tar = Bun.spawnSync({
    cmd: ["tar", "-xzf", localArchive, "-C", staging],
    stdout: "pipe",
    stderr: "pipe",
  });
  await unlink(localArchive).catch(() => {});

  if (tar.exitCode !== 0) {
    throw new Error(`unpacking the sandbox archive failed: ${new TextDecoder().decode(tar.stderr).trim()}`);
  }

  return staging;
}

/**
 * Writes a file the way the rest of the product writes files: to a temporary
 * sibling, then renamed over the target.
 *
 * The rename is atomic on one filesystem, so an interrupted pull leaves either
 * the old file or the new one and never half of either. The same technique as
 * `writeJsonAtomic` in `config/config.ts`.
 */
async function writeAtomically(target: string, contents: ArrayBuffer): Promise<void> {
  const temporary = `${target}.woopcode-${crypto.randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await Bun.write(temporary, contents);
  await rename(temporary, target);
}

/**
 * Applies what the command did, honouring anything the user did meanwhile.
 *
 * `snapshot` is the tree that was handed to the command. A local file still
 * matching it was not touched by anyone since, so the sandbox's version can
 * replace it safely. A local file that no longer matches was edited by the user
 * while the command ran, and that edit wins — the sandbox's version is written
 * beside it as `<path>.sandbox` and reported, because quietly discarding either
 * side is the one outcome nobody can recover from.
 */
export async function applyChanges(
  workspace: string,
  staging: string,
  snapshot: Manifest,
  changed: readonly string[],
  deleted: readonly string[],
  report: SyncReport,
): Promise<void> {
  for (const relativePath of changed) {
    const target = path.join(workspace, relativePath);
    const staged = path.join(staging, relativePath);

    const stagedFile = Bun.file(staged);
    if (!(await stagedFile.exists())) continue;

    if (await localMatchesSnapshot(target, snapshot.get(relativePath)?.hash)) {
      await writeAtomically(target, await stagedFile.arrayBuffer());
      report.written.push(relativePath);
      continue;
    }

    const savedAs = `${relativePath}.sandbox`;
    await writeAtomically(path.join(workspace, savedAs), await stagedFile.arrayBuffer());
    report.conflicts.push({ path: relativePath, savedAs, kind: "modified" });
  }

  for (const relativePath of deleted) {
    const target = path.join(workspace, relativePath);

    if (await localMatchesSnapshot(target, snapshot.get(relativePath)?.hash)) {
      await unlink(target).catch(() => {});
      report.deleted.push(relativePath);
      continue;
    }

    report.conflicts.push({ path: relativePath, kind: "deleted" });
  }
}

/**
 * Whether the working tree still holds what the command was given.
 *
 * A missing snapshot entry means the command created the path, so there was
 * nothing for the user to have changed; a missing local file means the same.
 */
async function localMatchesSnapshot(
  absolutePath: string,
  snapshotHash: string | undefined,
): Promise<boolean> {
  const file = Bun.file(absolutePath);
  if (!(await file.exists())) return true;
  if (!snapshotHash) return false;

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await file.arrayBuffer());
  return hasher.digest("hex") === snapshotHash;
}

/**
 * What the model is told, when there is anything worth telling it.
 *
 * Empty in the ordinary case. A note on every command would be noise the model
 * learns to skip, and then the one that mattered goes with it.
 */
export function describeForModel(report: SyncReport): string {
  const lines: string[] = [];

  for (const conflict of report.conflicts) {
    lines.push(
      conflict.kind === "modified"
        ? `${conflict.path} was changed locally while the command ran, so it was left ` +
          `as it is; the sandbox's version is at ${conflict.savedAs}.`
        : `${conflict.path} was deleted in the sandbox but has local changes, so it ` +
          `was kept.`,
    );
  }

  const refusedSecrets = report.refused.filter((entry) => entry.reason === "secret");
  if (refusedSecrets.length > 0) {
    lines.push(
      `Not brought back from the sandbox because they look like credentials: ` +
        `${refusedSecrets.map((entry) => entry.path).join(", ")}.`,
    );
  }

  const capped = report.refused.filter(
    (entry) => entry.reason === "over-file-cap" || entry.reason === "over-byte-cap",
  );
  if (capped.length > 0) {
    lines.push(
      `${capped.length} more changed files were not brought back — the sync limit ` +
        `was reached. They are still in the sandbox.`,
    );
  }

  const outside = report.refused.filter((entry) => entry.reason === "outside-workspace");
  if (outside.length > 0) {
    lines.push(
      `Refused paths outside the workspace: ${outside.map((entry) => entry.path).join(", ")}.`,
    );
  }

  if (report.refused.some((entry) => entry.reason === "manifest-unavailable")) {
    lines.push(
      "The sandbox could not be listed after the command, so nothing was brought " +
        "back. Local files are unchanged and anything the command wrote is still " +
        "in the sandbox.",
    );
  }

  return lines.length > 0 ? `\n\n[sandbox sync]\n${lines.join("\n")}` : "";
}
