import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Resolve a local-tool path without permitting it to leave the repository in
 * which Woopcode was launched. Real paths are checked as well as lexical paths
 * so a symlink cannot be used to escape the workspace.
 */
export async function resolveWorkspacePath(
  input: string,
  options: { mustExist?: boolean; root?: string } = {},
): Promise<string> {
  if (!input || typeof input !== "string") {
    throw new Error("Path is required");
  }

  // `root` exists for the sandbox sync, which resolves paths against the tree it
  // was handed rather than against the process's directory. It is a parameter
  // rather than a second copy of this function: the containment rule — resolve
  // symlinks first, then compare — is the one thing in this codebase that must
  // not exist twice, because a second version is a second thing to get wrong.
  const workspace = await realpath(options.root ?? process.cwd());
  const candidate = path.resolve(workspace, input);
  assertWithinWorkspace(candidate, workspace, input);

  try {
    const resolved = await realpath(candidate);
    assertWithinWorkspace(resolved, workspace, input);
    return resolved;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Path escapes the workspace:")) {
      throw error;
    }
    // A new file does not have a real path yet. Resolve its nearest existing
    // parent, which also detects symlinked directories that leave the repo.
    let parent = path.dirname(candidate);
    while (parent !== path.dirname(parent)) {
      let resolvedParent: string;
      try {
        resolvedParent = await realpath(parent);
        assertWithinWorkspace(resolvedParent, workspace, input);
      } catch (parentError) {
        if (
          parentError instanceof Error &&
          parentError.message.startsWith("Path escapes the workspace:")
        ) {
          throw parentError;
        }
        parent = path.dirname(parent);
        continue;
      }

      if (options.mustExist) {
        throw error;
      }
      return candidate;
    }

    throw error;
  }
}

function assertWithinWorkspace(candidate: string, workspace: string, input: string) {
  const relative = path.relative(workspace, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }

  throw new Error(`Path escapes the workspace: ${input}`);
}
