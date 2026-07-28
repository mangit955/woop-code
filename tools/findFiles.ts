import type { Tool } from "../config/types";
import { resolveWorkspacePath } from "./workspace";

export const findFilesTool: Tool = {
  name: "find_files",
  description: "Finds files by name or partial filename. Use specific queries (e.g., 'websocket', 'config') rather than broad patterns (e.g., '.').",
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

    const matches: string[] = [];
    const lowerQuery = query.toLowerCase();

    const glob = new Bun.Glob("**/*");
    for await (const entry of glob.scan(rootPath)) {
      const parts = entry.split("/");
      if (
        parts.some((part) =>
          [
            ".git",
            "node_modules",
            "dist",
            "build",
            ".next",
            "coverage",
          ].includes(part),
        )
      ) {
        continue;
      }
      const basename = parts.at(-1);
      if (!basename) {
        continue;
      }
      if (
        [
          "bun.lock",
          "package-lock.json",
          "pnpm-lock.yaml",
          "yarn.lock",
        ].includes(basename)
      ) {
        continue;
      }
      if (
        basename.toLowerCase().includes(lowerQuery) ||
        entry.toLowerCase().includes(lowerQuery)
      ) {
        // Only include files, not directories
        const fullPath = `${rootPath}/${entry}`;
        try {
          const stat = await Bun.file(fullPath).stat();
          if (!stat.isDirectory) {
            matches.push(entry);
          }
        } catch {
          // If we can't stat it, skip it
          continue;
        }
      }
    }

    if (matches.length === 0) {
      // Check if the query matches a directory
      const queryPath = `${rootPath}/${query}`;
      try {
        const stat = await Bun.file(queryPath).stat();
        if (stat.isDirectory) {
          return `"${query}" is a directory. Use list_files with path="${query}" to see its contents.`;
        }
      } catch {
        // Not a valid path
      }
      
      return `No matching files found for "${query}". Try:\n- Use list_files to see directory contents\n- Use a more specific or different search term\n- Check if the file exists in the project`;
    }

    const output = matches.join("\n");
    const MAX_OUTPUT_SIZE = 8 * 1024; // 8 KB

    if (output.length <= MAX_OUTPUT_SIZE) {
      return output;
    }

    return (
      output.slice(0, MAX_OUTPUT_SIZE) +
      `\n\n... output truncated (${matches.length} matches found)`
    );
  },
};
