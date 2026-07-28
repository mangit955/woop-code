import type { Tool } from "../config/types";
import { existsSync } from "fs";
import { resolveWorkspacePath } from "./workspace";
import { createTwoFilesPatch } from "diff";
import { store } from "../tui/src/store/ui-store";
import type { PendingEdit } from "../tui/src/types";

export const createFileTool: Tool = {
  name: "create_file",
  description: "Creates a new file with the provided content.",
  parameters: [
    { name: "path", description: "File path", required: true },
    { name: "content", description: "File content", required: true },
  ],
  async execute(args) {
    const requestedPath = args.path as string;
    const content = args.content as string;

    if (!requestedPath) throw new Error("Missing required argument: path");
    if (!content) throw new Error("Missing required argument: content");

    const path = await resolveWorkspacePath(requestedPath);

    if (existsSync(path)) {
      throw new Error(`File already exists: ${path}`);
    }

    const pendingEdit: PendingEdit = {
      id: crypto.randomUUID(),
      filePath: path,
      oldContent: "",
      newContent: content,
      diff: createTwoFilesPatch(path, path, "", content, "", "", { context: 3 }),
      toolCallId: crypto.randomUUID(),
    };

    const approved = await store.setPendingEdit(pendingEdit);
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
