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
    const content = args.content as string;
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

    // Read current content
    const oldContent = await file.text();

    // If content is identical, skip diff preview
    if (oldContent === content) {
      return `No changes needed for ${path}`;
    }

    // Generate unified diff
    const diff = createTwoFilesPatch(path, path, oldContent, content, "", "", {
      context: 3,
    });

    // Create pending edit
    const pendingEdit: PendingEdit = {
      id: crypto.randomUUID(),
      filePath: path,
      oldContent,
      newContent: content,
      diff,
      toolCallId: crypto.randomUUID(),
    };

    // Request approval from UI
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

    // Write file after approval
    await Bun.write(path, content);

    return `Updated ${path}`;
  },
};
