/**
 * Where does a path point?
 *
 * The classifier decides "inside or outside", so it needs a way to turn a raw
 * shell token into an answer. That is two jobs, and they are kept apart here:
 *
 *  - **normalize** turns a token into an absolute path when it can. `~/x`,
 *    `./x`, `../x` and `/x` all become one comparable form.
 *  - **locate** compares that form against the workspace root.
 *
 * Splitting them is what lets a new spelling of a path — `$HOME`, `%APPDATA%`,
 * a Windows drive letter — become one case in `normalize` rather than a new
 * branch in every boundary check.
 *
 * Normalisation is lexical. It never touches the filesystem, so it cannot see
 * through a symlink; `tools/workspace.ts` does the real-path check for the file
 * tools, which can afford to be async. What this module guarantees is weaker
 * and stated plainly: a token it calls `inside` contains no way of leaving.
 */

import os from "node:os";
import path from "node:path";

/** The root every path is judged against. */
export interface WorkspaceContext {
  /** Absolute path to the workspace root. */
  readonly root: string;
  /** Used to expand `~`. Absent means `~` cannot be resolved. */
  readonly home?: string;
}

/**
 * `unknown` is not a third outcome to handle — it is `outside` with a reason.
 * Callers must treat it as an escape, which is what keeps an unexpanded
 * `$TARGET` from being waved through.
 */
export type PathLocation = "inside" | "outside" | "unknown";

export interface NormalizedPath {
  readonly raw: string;
  /** Set only when the token could be resolved to one place on disk. */
  readonly absolute?: string;
  readonly location: PathLocation;
}

/**
 * Stands in for a destination a command decides at runtime — gawk's
 * `print > variable`, for one. It normalises to `unknown`, so an extractor that
 * cannot name a path can still say so honestly.
 */
export const UNRESOLVABLE = "\u0000unresolvable";

/** `$VAR`, `${VAR}`, `` `cmd` ``, `%APPDATA%`: expanded by the shell, not by us. */
const UNEXPANDED = /[$`]|%[A-Za-z_][A-Za-z0-9_]*%/;

/** `C:\x`, `C:/x`, `\\server\share`. */
const WINDOWS_ABSOLUTE = /^([A-Za-z]:[\\/]|\\\\)/;

export function defaultWorkspaceContext(): WorkspaceContext {
  return { root: process.cwd(), home: os.homedir() };
}

export function workspaceContext(context?: Partial<WorkspaceContext>): WorkspaceContext {
  const defaults = defaultWorkspaceContext();
  return {
    root: path.resolve(context?.root ?? defaults.root),
    home: context?.home ?? defaults.home,
  };
}

export function normalizePath(raw: string, context: WorkspaceContext): NormalizedPath {
  const unknown = (): NormalizedPath => ({ raw, location: "unknown" });

  // `includes`, not `===`: a substitution can be part of a longer word, as in
  // `build/$(date)/out`.
  if (raw === "" || raw.includes(UNRESOLVABLE)) return unknown();

  // The shell expands these before the command ever sees them, so their
  // destination is not knowable here.
  if (UNEXPANDED.test(raw)) return unknown();

  // A drive letter means nothing on a POSIX host, and joining it onto the root
  // would make it look local. Say so instead of guessing.
  if (WINDOWS_ABSOLUTE.test(raw) && path.sep !== "\\") return unknown();

  let expanded = raw;
  if (raw === "~" || raw.startsWith("~/")) {
    if (!context.home) return unknown();
    expanded = path.join(context.home, raw.slice(1));
  } else if (raw.startsWith("~")) {
    // `~otheruser/...`: another account's home, and not one we can resolve.
    return unknown();
  }

  return locate(path.resolve(context.root, expanded), context);
}

function locate(absolute: string, context: WorkspaceContext): NormalizedPath {
  const relative = path.relative(context.root, absolute);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));

  return { raw: absolute, absolute, location: inside ? "inside" : "outside" };
}

/**
 * The boundary question, in the form the classifier asks it.
 *
 * Note the inversion: anything not provably inside escapes. "I could not tell"
 * and "it points at /etc" get the same answer on purpose.
 */
export function escapesWorkspace(raw: string, context: WorkspaceContext): boolean {
  return normalizePath(raw, context).location !== "inside";
}
