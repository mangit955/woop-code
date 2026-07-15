import type { Tool } from "../config/types";

export const findFilesTool: Tool = {
  name: "find_files",
  description: "Finds files by name or partial filename.",
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
    const rootPath =
      args.path && typeof args.path === "string" ? args.path : process.cwd();

    const matches: string[] = [];
    const lowerQuery = query.toLowerCase();

    const glob = new Bun.Glob("**/*");
    for await (const entry of glob.scan(rootPath)) {
      const parts = entry.split("/");
      if (
        parts.includes(".git") ||
        parts.includes("node_modules") ||
        parts.includes("dist")
      ) {
        continue;
      }
      const basename = parts.at(-1);
      if (!basename) {
        continue;
      }
      if (
        basename.toLowerCase().includes(lowerQuery) ||
        entry.toLowerCase().includes(lowerQuery)
      ) {
        matches.push(entry);
      }
    }

    if (matches.length === 0) {
      return "No matching files found.";
    }
    return matches.join("\n");
  },
};
