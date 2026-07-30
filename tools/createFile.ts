import type { Tool } from "../config/types";
import { existsSync } from "fs";
import { resolveWorkspacePath } from "./workspace";
import { createTwoFilesPatch } from "diff";
import { store } from "../tui/src/store/ui-store";
import type { PendingEdit } from "../tui/src/types";

export const createFileTool: Tool = {
  name: "create_file",
  description:
    "Creates a new file with the provided content. Pass an empty string to create an empty file.",
  parameters: [
    { name: "path", description: "File path", required: true },
    {
      name: "content",
      description: "File content. May be an empty string for an empty file.",
      required: true,
    },
  ],
  async execute(args) {
    const requestedPath = args.path as string;
    const content = args.content;

    if (!requestedPath) throw new Error("Missing required argument: path");
    // An empty file is a legitimate result (.gitkeep, __init__.py, a stub a
    // later edit fills in), so only an absent value is an error.
    if (content === undefined || content === null) {
      throw new Error("Missing required argument: content");
    }
    if (typeof content !== "string") {
      throw new Error("Argument 'content' must be a string");
    }

    const path = await resolveWorkspacePath(requestedPath);

    if (existsSync(path)) {
      throw new Error(`File already exists: ${path}`);
    }

    const patch = createTwoFilesPatch(path, path, "", content, "", "", {
      context: 3,
    });

    const pendingEdit: PendingEdit = {
      id: crypto.randomUUID(),
      filePath: path,
      oldContent: "",
      newContent: content,
      // An empty file produces a header-only patch with no +/- lines, which
      // reads as "nothing will happen". Say what is being approved instead.
      diff: content === "" ? `${patch}(new empty file)\n` : patch,
      toolCallId: crypto.randomUUID(),
    };

    // Cancelling the turn rejects this promise. Reachable now that Ctrl+C works
    // while the approval is on screen; editFile and writeFile already did this.
    let approved: boolean;
    try {
      approved = await store.setPendingEdit(pendingEdit);
    } catch {
      const outcome = `Create cancelled for ${path}. No file was created.`;
      store.addSystemMessage(outcome);
      return outcome;
    }

    if (!approved) {
      const outcome = `Create rejected for ${path}. No file was created.`;
      store.addSystemMessage(outcome);
      return outcome;
    }

    // Do not overwrite a file created while the user reviewed the preview.
    if (existsSync(path)) {
      throw new Error(`File was created before approval: ${path}`);
    }
    await Bun.write(path, content);
    return `Created file: ${path}`;
  },
};
