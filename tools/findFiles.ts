import { stat } from "node:fs/promises";
import type { Tool } from "../config/types";
import { resolveWorkspacePath } from "./workspace";
import { limitOutput, walkWorkspace } from "./scan";

const MAX_RESULTS = 200;
const MAX_OUTPUT_SIZE = 8 * 1024; // 8 KB

export const findFilesTool: Tool = {
  name: "find_files",
  description: `Finds files by name or partial filename, skipping dependency and build directories. Returns up to ${MAX_RESULTS} matches. Use specific queries (e.g., 'websocket', 'config') rather than broad patterns (e.g., '.').`,
  parameters: [
    {
      name: "query",
      required: true,
      description: "filename or partial filename",
    },
    {
      name: "path",
      required: false,
      description: "root directory, default process.cwd()",
    },
  ],
  async execute(args) {
    const query = args.query;
    if (!query || typeof query !== "string") {
      throw new Error("Parameter 'query' is required and must be a string.");
    }

    // Prevent overly broad searches that waste tokens
    if (query === "." || query === "*" || query === "**" || query.length <= 1) {
      return "Error: Query too broad or too short. Please provide a specific filename or pattern with at least 2 characters (e.g., 'websocket', 'config', 'auth', 'index').";
    }

    const requestedPath =
      args.path && typeof args.path === "string" ? args.path : process.cwd();
    const rootPath = await resolveWorkspacePath(requestedPath, { mustExist: true });

    const lowerQuery = query.toLowerCase();

    // Matching happens during the walk, so the scan stops at MAX_RESULTS
    // instead of collecting the whole tree and slicing afterwards.
    const { files, hitResultLimit, hitEntryLimit } = await walkWorkspace(rootPath, {
      maxResults: MAX_RESULTS,
      match: (relativePath, name) =>
        name.toLowerCase().includes(lowerQuery) ||
        relativePath.toLowerCase().includes(lowerQuery),
    });

    if (files.length === 0) {
      // The query may name a directory rather than a file.
      try {
        const queryPath = await resolveWorkspacePath(`${rootPath}/${query}`, {
          mustExist: true,
        });
        if ((await stat(queryPath)).isDirectory()) {
          return `"${query}" is a directory. Use list_files with path="${query}" to see its contents.`;
        }
      } catch {
        // Not a valid path inside the workspace.
      }

      const scope = hitEntryLimit
        ? "\n- The search stopped early because the tree is very large; try a narrower path"
        : "";

      return `No matching files found for "${query}". Try:\n- Use list_files to see directory contents\n- Use a more specific or different search term\n- Check if the file exists in the project${scope}`;
    }

    const notes: string[] = [];
    if (hitResultLimit) {
      notes.push(
        `Stopped after ${MAX_RESULTS} matches. Use a more specific query or pass a narrower path.`,
      );
    }
    if (hitEntryLimit) {
      notes.push(
        "Stopped early: this directory tree is very large, so some files were not searched. Pass a narrower path.",
      );
    }

    // Truncate the listing first so the notes always survive the byte cap.
    const listing = limitOutput(files.join("\n"), MAX_OUTPUT_SIZE);

    return [listing, ...notes].join("\n\n");
  },
};
