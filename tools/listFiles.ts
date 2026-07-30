import type { Tool } from "../config/types";
import { resolveWorkspacePath } from "./workspace";
import { limitOutput, walkWorkspace } from "./scan";

const MAX_RESULTS = 500;
const MAX_TOOL_OUTPUT = 8 * 1024; // 8 KB

export const listFilesTool: Tool = {
  name: "list_files",
  description: `List files in a directory, skipping dependency and build directories. Returns up to ${MAX_RESULTS} files. Use sparingly - only when you need to see directory structure. For finding specific files, use find_files instead.`,
  parameters: [
    {
      name: "path",
      description: "Directory path",
      required: false,
    },
  ],

  async execute(args) {
    const path = await resolveWorkspacePath((args.path as string) || process.cwd(), {
      mustExist: true,
    });

    const { files, hitResultLimit, hitEntryLimit } = await walkWorkspace(path, {
      maxResults: MAX_RESULTS,
    });

    if (files.length === 0) {
      return "No files found.";
    }

    const notes: string[] = [];
    if (hitResultLimit) {
      notes.push(
        `Stopped after ${MAX_RESULTS} files. Pass a more specific path, or use glob/find_files to target what you need.`,
      );
    }
    if (hitEntryLimit) {
      notes.push(
        "Stopped early: this directory tree is very large. Pass a more specific path.",
      );
    }

    // Truncate the listing first so the notes always survive the byte cap.
    const listing = limitOutput(files.join("\n"), MAX_TOOL_OUTPUT);

    return [listing, ...notes].join("\n\n");
  },
};
