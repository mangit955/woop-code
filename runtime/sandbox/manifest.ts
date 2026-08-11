/**
 * What a tree contains, by content.
 *
 * A manifest is `path → sha256`. Everything about keeping local disk and a
 * sandbox in agreement is a diff between two of these, which is what makes the
 * agreement checkable rather than assumed.
 *
 * **Content decides. Nothing else is consulted.**
 *
 * There was a stat filter here — skip the read when size and mtime both match
 * the last pass — and it looked free: 1ms warm against 65ms cold. It was not
 * free. A file rewritten to the same length with its mtime put back keeps its
 * old entry, and `cp -p`, `tar -x`, `touch -d` and a restored backup all do
 * exactly that. The filter's saving is 64ms; a command reading a stale file
 * because of it is the silent divergence this whole module exists to prevent.
 *
 * It survived its own test, too. The test that was supposed to catch this
 * passed a fresh manifest on both sides, so the filter never engaged and a
 * deliberate mutation of it changed nothing. Hashing everything, every time,
 * removes the branch and the way to be wrong about it — and 65ms is noise
 * beside the 300ms round trip that follows.
 */

import path from "node:path";

export interface ManifestEntry {
  hash: string;
}

/** Workspace-relative path → content hash. */
export type Manifest = Map<string, ManifestEntry>;

/** How many files are hashed at once. Bounded so a big tree cannot exhaust fds. */
const HASH_CONCURRENCY = 32;

export async function hashFile(absolutePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(absolutePath).arrayBuffer());
  return hasher.digest("hex");
}

/** Hashes every listed file. */
export async function buildManifest(
  root: string,
  files: readonly string[],
): Promise<Manifest> {
  const manifest: Manifest = new Map();

  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const relativePath = files[cursor++]!;
      const absolute = path.join(root, relativePath);

      try {
        manifest.set(relativePath, { hash: await hashFile(absolute) });
      } catch {
        // Listed but gone, or unreadable: deleted between the listing and now,
        // or a broken symlink. Absent from the manifest is the correct
        // description of that.
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(HASH_CONCURRENCY, files.length) }, worker),
  );

  return manifest;
}

export interface ManifestDiff {
  /** In `after` with a different hash, or absent from `before`. */
  changed: string[];
  /** In `before` and gone from `after`. */
  deleted: string[];
}

/**
 * What happened to `before` to produce `after`.
 *
 * Direction matters and is easy to get backwards: `before` is always the state
 * someone believed was true, `after` is what is true now.
 */
export function diffManifests(
  before: Manifest,
  after: Manifest,
): ManifestDiff {
  const changed: string[] = [];
  const deleted: string[] = [];

  for (const [relativePath, entry] of after) {
    const previous = before.get(relativePath);
    if (!previous || previous.hash !== entry.hash) changed.push(relativePath);
  }

  for (const relativePath of before.keys()) {
    if (!after.has(relativePath)) deleted.push(relativePath);
  }

  return { changed: changed.sort(), deleted: deleted.sort() };
}

/**
 * Parses `sha256sum` output into a manifest.
 *
 * The format is `<hash>  <path>` — two spaces for text mode, and a path that may
 * itself contain spaces, so the split is on the first separator only and never
 * on whitespace generally.
 */
export function parseSha256Sums(output: string, stripPrefix = "./"): Manifest {
  const manifest: Manifest = new Map();

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;

    const separator = line.indexOf("  ");
    if (separator === -1) continue;

    const hash = line.slice(0, separator).trim();
    // `sha256sum` marks binary files with a '*' where the second space would be.
    let file = line.slice(separator + 2).replace(/^\*/, "");
    if (file.startsWith(stripPrefix)) file = file.slice(stripPrefix.length);

    if (!/^[0-9a-f]{64}$/.test(hash) || !file) continue;

    manifest.set(file, { hash });
  }

  return manifest;
}
