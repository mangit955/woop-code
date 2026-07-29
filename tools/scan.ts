import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Directory walking shared by list_files and find_files.
 *
 * Two things matter for cost. Ignored directories are pruned *before*
 * descending into them, so a repository with a large node_modules is never
 * traversed, and the walk stops the moment it has enough results or has looked
 * at enough entries — a capped result set is worthless if producing it still
 * cost a full-tree scan.
 */

export const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
]);

export const IGNORED_FILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

/** How many directory entries a single walk may look at before giving up. */
export const DEFAULT_MAX_ENTRIES = 20_000;

export interface WalkOptions {
  /** Stop as soon as this many files have been collected. */
  maxResults: number;
  maxEntries?: number;
  /** Return true to keep a file. Directories are never returned. */
  match?: (relativePath: string, name: string) => boolean;
}

export interface WalkResult {
  files: string[];
  /** Directory entries examined, including pruned directories. */
  scanned: number;
  /** The walk stopped early because `maxResults` was reached. */
  hitResultLimit: boolean;
  /** The walk stopped early because `maxEntries` was reached. */
  hitEntryLimit: boolean;
}

export async function walkWorkspace(
  root: string,
  options: WalkOptions,
): Promise<WalkResult> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const match = options.match;

  const files: string[] = [];
  const stack: string[] = [""];
  let scanned = 0;
  let hitResultLimit = false;
  let hitEntryLimit = false;

  while (stack.length > 0) {
    const relativeDir = stack.pop()!;

    let entries;
    try {
      entries = await readdir(path.join(root, relativeDir), {
        withFileTypes: true,
      });
    } catch {
      // Unreadable directory (permissions, race with a delete): skip it rather
      // than failing the whole listing.
      continue;
    }

    // Deterministic output, and directories are pushed in reverse so the walk
    // still visits them alphabetically.
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const subdirectories: string[] = [];

    for (const entry of entries) {
      scanned++;
      if (scanned >= maxEntries) {
        hitEntryLimit = true;
        return { files, scanned, hitResultLimit, hitEntryLimit };
      }

      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // Pruned here, so nothing inside is ever read.
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          subdirectories.push(relativePath);
        }
        continue;
      }

      // Symlinks are listed but never followed, so the walk cannot loop or
      // wander outside the workspace.
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (IGNORED_FILES.has(entry.name)) continue;
      if (match && !match(relativePath, entry.name)) continue;

      files.push(relativePath);

      if (files.length >= options.maxResults) {
        hitResultLimit = true;
        return { files, scanned, hitResultLimit, hitEntryLimit };
      }
    }

    for (let i = subdirectories.length - 1; i >= 0; i--) {
      stack.push(subdirectories[i]!);
    }
  }

  return { files, scanned, hitResultLimit, hitEntryLimit };
}

/** Trims tool output to a byte budget, explaining the cut. */
export function limitOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;

  return (
    output.slice(0, maxChars) +
    `\n\n... output truncated (${output.length - maxChars} more characters)`
  );
}
