import type { Tool } from "../config/types";
import path from "path";
import { statSync } from "fs";
import { resolveWorkspacePath } from "./workspace";

export const globTool: Tool = {
  name: "glob",
  description: `Search for files matching a glob pattern. Supports wildcards like *, **, ?, [abc], etc.
  
Examples:
- "*.ts" - All TypeScript files in current directory
- "**/*.test.ts" - All test files recursively
- "src/**/*.{ts,tsx}" - TypeScript/TSX files in src/
- "*.{js,json}" - JS and JSON files

Returns up to 100 matching file paths.`,

  parameters: [
    {
      name: "pattern",
      description: "The glob pattern to match files against (e.g., '**/*.ts', 'src/**/*.json')",
      required: true,
    },
    {
      name: "path",
      description: "The directory to search in. If not specified, uses current working directory. Must be a valid directory path if provided.",
      required: false,
    },
  ],

  async execute(args) {
    const pattern = args.pattern as string;
    const searchPath = (args.path as string | undefined) ?? process.cwd();

    if (!pattern) {
      throw new Error("Pattern is required");
    }

    const resolvedPath = await resolveWorkspacePath(searchPath, { mustExist: true });

    try {
      if (statSync(resolvedPath).isFile()) {
        throw new Error(`glob path must be a directory: ${resolvedPath}`);
      }
    } catch (err: any) {
      // Only the directory check is worth failing on. Anything else stat can
      // raise means the path is not readable yet, which Glob reports itself as
      // an empty scan.
      if (err.message?.includes("glob path must be a directory")) {
        throw err;
      }
    }

    const LIMIT = 100;
    const files: string[] = [];

    try {
      const glob = new Bun.Glob(pattern);

      for await (const file of glob.scan({
        cwd: resolvedPath,
        onlyFiles: true,
      })) {
        if (files.length >= LIMIT) {
          break;
        }

        files.push(path.resolve(resolvedPath, file));
      }
    } catch (error) {
      throw new Error(`Glob search failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const output: string[] = [];

    if (files.length === 0) {
      output.push("No files found");
    } else {
      output.push(...files);


      if (files.length === LIMIT) {
        output.push("");
        output.push(
          `(Results are truncated: showing first ${LIMIT} results. ` +
          `Consider using a more specific path or pattern.)`
        );
      }
    }

    return output.join("\n");
  },
};
