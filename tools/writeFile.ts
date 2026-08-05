import type { Tool } from "../config/types";
import { createTwoFilesPatch } from "diff";
import { store } from "../tui/src/store/ui-store";
import type { PendingEdit } from "../tui/src/types";
import { resolveWorkspacePath } from "./workspace";

export const writeFileTool: Tool = {
  name: "write_file",

  description: "Overwrite an existing file.",

  parameters: [
    {
      name: "path",
      description: "File path",
      required: true,
    },
    {
      name: "content",
      description: "New file contents",
      required: true,
    },
  ],

  async execute(args) {
    const requestedPath = args.path as string;
    const content = args.content;

    // Empty content is allowed here too — truncating a file is a real edit —
    // but an absent or non-string value would reach Bun.write as garbage.
    if (content === undefined || content === null) {
      throw new Error("Missing required argument: content");
    }
    if (typeof content !== "string") {
      throw new Error("Argument 'content' must be a string");
    }

    let path: string;
    try {
      path = await resolveWorkspacePath(requestedPath, { mustExist: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`File not found: ${requestedPath}`);
      }
      throw error;
    }

    const file = Bun.file(path);

    if (!(await file.exists())) {
      throw new Error(`File not found: ${path}`);
    }

    const oldContent = await file.text();

    // If content is identical, skip diff preview
    if (oldContent === content) {
      return `No changes needed for ${path}`;
    }

    const diff = createTwoFilesPatch(path, path, oldContent, content, "", "", {
      context: 3,
    });

    const pendingEdit: PendingEdit = {
      id: crypto.randomUUID(),
      filePath: path,
      oldContent,
      newContent: content,
      diff,
      toolCallId: crypto.randomUUID(),
    };

    let approved: boolean;
    try {
      approved = await store.setPendingEdit(pendingEdit);
    } catch (error) {
      const outcome = `Edit cancelled for ${path}. No changes were applied.`;
      store.addSystemMessage(outcome);
      return outcome;
    }

    if (!approved) {
      const outcome = `Edit rejected for ${path}. No changes were applied. Do not claim this edit was completed.`;
      store.addSystemMessage(outcome);
      return outcome;
    }

    // The only write in this tool, and it sits below both exits above. Nothing
    // may move above them: the diff review is the product's whole guarantee.
    await Bun.write(path, content);

    return `Updated ${path}`;
  },
};
