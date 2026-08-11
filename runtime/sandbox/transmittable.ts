/**
 * What may leave this machine.
 *
 * A stricter question than "what is in this repository", and the difference is
 * the whole point. `walkWorkspace` in `tools/scan.ts` decides what to *list* for
 * the model, and it filters on a fixed set of directory names — it has never
 * read `.gitignore`, because it never needed to. Reusing it here would have
 * uploaded this repository's own `.env`, holding the provider keys and the E2B
 * key, to a virtual machine on the first sandboxed command.
 *
 * So three filters, narrowing:
 *
 *   1. git's answer to what matters, which is `.gitignore` applied properly,
 *      nested files and all — a rule git already owns and this should not
 *      reimplement.
 *   2. a denylist of secret-shaped names, applied even when a repository has
 *      chosen to commit them. Being tracked is not evidence that a private key
 *      should be copied somewhere else.
 *   3. a size cap, because 93% of this repository's 80MB is committed marketing
 *      video and pushing it cost 22 seconds of every session start.
 *
 * Nothing outside the workspace is ever considered, so `~/.ssh` and the cloud
 * credential files are excluded by construction rather than by a rule that could
 * be got wrong.
 */

import path from "node:path";
import { lstat } from "node:fs/promises";
import { walkWorkspace } from "../../tools/scan";

/**
 * Names that never travel, whatever a repository has committed.
 *
 * Matched against the workspace-relative path so a nested `config/.env.production`
 * is caught as readily as one at the root.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env($|\.)/,
  /\.pem$/,
  /\.key$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)($|\.|$)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.pgpass$/,
  /(^|\/)credentials$/,
  /(^|\/)\.aws\//,
  /(^|\/)\.ssh\//,
];

export function isSecretShaped(relativePath: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(relativePath));
}

/**
 * The default size cap, in bytes.
 *
 * One megabyte. Source files are not this big; the things that are tend to be
 * media, fixtures and checked-in binaries, none of which a command reads. A
 * repository that genuinely needs a larger file raises the cap rather than
 * losing the protection.
 */
export const DEFAULT_MAX_FILE_BYTES = 1_048_576;

/** How many files a single push will carry, as a backstop against a huge tree. */
export const MAX_TRANSMITTED_FILES = 20_000;

export type SkipReason = "secret" | "too-large";

export interface SkippedFile {
  path: string;
  reason: SkipReason;
  /** Present for `too-large`, so the report can say how far over it was. */
  bytes?: number;
}

export interface TransmittableSet {
  /** Workspace-relative paths, in git's order. */
  files: string[];
  skipped: SkippedFile[];
  totalBytes: number;
  /** True when git listed the files; false when the fallback walk did. */
  fromGit: boolean;
  /** The walk stopped at `MAX_TRANSMITTED_FILES`. */
  truncated: boolean;
}

/**
 * Every file git considers part of the tree: tracked, plus untracked that is not
 * ignored. `-z` because a filename may contain a newline and splitting on one
 * would invent two paths that do not exist.
 *
 * Returns null when this is not a git repository, or git is not installed, so
 * the caller can fall back rather than push nothing.
 */
function gitListedFiles(root: string): string[] | null {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync({
      cmd: ["git", "ls-files", "-co", "--exclude-standard", "-z"],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    // No git binary at all.
    return null;
  }

  if (result.exitCode !== 0) return null;

  return new TextDecoder().decode(result.stdout).split("\0").filter(Boolean);
}

/**
 * The fallback listing, for a directory that is not a git repository.
 *
 * `walkWorkspace`'s ignore rules are coarser than `.gitignore` — they are a
 * fixed list of directory names — but they prune the expensive directories and
 * the secret denylist and size cap still apply on top, so the guarantees that
 * matter do not depend on git being present.
 */
async function walkedFiles(root: string): Promise<string[]> {
  const walk = await walkWorkspace(root, { maxResults: MAX_TRANSMITTED_FILES });
  return walk.files;
}

export interface TransmittableOptions {
  maxFileBytes?: number;
}

/**
 * Resolves what will be sent to a sandbox, and what will not.
 *
 * Skipped files are returned rather than dropped: a command that cannot find a
 * file needs the reason to be visible somewhere, and "your 40MB fixture was too
 * large" is a different problem from "your build is broken".
 */
export async function transmittableSet(
  root: string,
  options: TransmittableOptions = {},
): Promise<TransmittableSet> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const listed = gitListedFiles(root);
  const fromGit = listed !== null;
  const candidates = listed ?? (await walkedFiles(root));

  const files: string[] = [];
  const skipped: SkippedFile[] = [];
  let totalBytes = 0;
  let truncated = false;

  for (const relativePath of candidates) {
    if (files.length >= MAX_TRANSMITTED_FILES) {
      truncated = true;
      break;
    }

    // Before the stat: a secret is excluded whether or not it is readable, and
    // there is no reason to touch it at all.
    if (isSecretShaped(relativePath)) {
      skipped.push({ path: relativePath, reason: "secret" });
      continue;
    }

    // AppleDouble sidecars. macOS `tar` writes one per file carrying extended
    // attributes, GNU tar in a sandbox extracts them as ordinary files, and
    // they then look like files a command created. Never source, either way.
    if (path.basename(relativePath).startsWith("._")) {
      continue;
    }

    let bytes: number;
    try {
      // `lstat`, not `stat`: the difference is symlinks, and it decides whether
      // a symlink is described as itself or as whatever it points at.
      //
      // Regular files only, and symlinks are the reason. `find -type f` in a
      // sandbox does not match a symlink, so one pushed from here would be
      // absent from every listing that came back — and "absent from the
      // sandbox" is how this code recognises a deletion. A symlinked file in
      // the tree would therefore be deleted from the user's working copy after
      // the first command. Measured, on this repository: `.cursor/rules/` is a
      // symlink to CLAUDE.md, and it was deleted exactly that way.
      //
      // The cost is that a symlinked file is not visible inside the sandbox.
      // That is a limitation; deleting someone's file is a defect.
      const info = await lstat(path.join(root, relativePath));
      if (!info.isFile()) continue;
      bytes = info.size;
    } catch {
      // Listed but gone — deleted between the listing and now, or a broken
      // symlink. Not an error: it simply is not there to send.
      continue;
    }

    if (bytes > maxFileBytes) {
      skipped.push({ path: relativePath, reason: "too-large", bytes });
      continue;
    }

    files.push(relativePath);
    totalBytes += bytes;
  }

  return { files, skipped, totalBytes, fromGit, truncated };
}

/**
 * A short, human-readable account of what was held back.
 *
 * Shown once when a sandbox is created. Silence here would mean a command
 * failing to find a file with nothing anywhere saying why.
 */
export function describeSkipped(set: TransmittableSet): string {
  if (set.skipped.length === 0) return "";

  const secrets = set.skipped.filter((entry) => entry.reason === "secret");
  const large = set.skipped.filter((entry) => entry.reason === "too-large");

  const parts: string[] = [];
  if (secrets.length > 0) {
    parts.push(
      `${secrets.length} credential-shaped file${secrets.length === 1 ? "" : "s"} ` +
        `(${secrets.slice(0, 3).map((entry) => entry.path).join(", ")}${secrets.length > 3 ? ", …" : ""})`,
    );
  }
  if (large.length > 0) {
    const megabytes = large.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) / 1_048_576;
    parts.push(
      `${large.length} file${large.length === 1 ? "" : "s"} over the size cap ` +
        `(${megabytes.toFixed(1)}MB total)`,
    );
  }

  return `not sent to the sandbox: ${parts.join("; ")}`;
}
