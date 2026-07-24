import type { Tool } from "../config/types";
import { createTwoFilesPatch } from "diff";
import { store } from "../tui/src/store/ui-store";
import type { PendingEdit } from "../tui/src/types";

export const editFileTool: Tool = {
  name: "edit_file",
  description: "Replace text inside an existing file.",

  parameters: [
    {
      name: "path",
      description: "File path",
      required: true,
    },
    {
      name: "oldText",
      description: "Text to replace",
      required: true,
    },
    {
      name: "newText",
      description: "Replacement text",
      required: true,
    },
  ],

  async execute(args) {
    const path = args.path as string;
    const oldText = args.oldText as string;
    const newText = args.newText as string;

    const file = Bun.file(path);

    if (!(await file.exists())) {
      throw new Error(`File not found: ${path}`);
    }

    const content = await file.text();

    if (!content.includes(oldText)) {
      throw new Error("Text to replace not found.");
    }

    const updated = content.replace(oldText, newText);

    // If content is identical, skip diff preview
    if (content === updated) {
      return `No changes needed for ${path}`;
    }

    // Generate unified diff
    const diff = createTwoFilesPatch(path, path, content, updated, "", "", {
      context: 3,
    });

    // Create pending edit
    const pendingEdit: PendingEdit = {
      id: crypto.randomUUID(),
      filePath: path,
      oldContent: content,
      newContent: updated,
      diff,
      toolCallId: crypto.randomUUID(),
    };

    // Request approval from UI
    let approved: boolean;
    try {
      approved = await store.setPendingEdit(pendingEdit);
    } catch (error) {
      // User cancelled with Esc
      return `Edit cancelled for ${path}`;
    }

    if (!approved) {
      return `Edit rejected for ${path}`;
    }

    // Write file after approval
    await Bun.write(path, updated);

    return `Edited ${path}`;
  },
};
