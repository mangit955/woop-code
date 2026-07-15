import type { Tool } from "../config/types";

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

    await Bun.write(path, updated);

    return `Edited ${path}`;
  },
};
