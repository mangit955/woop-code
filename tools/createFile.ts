import type { Tool } from "../config/types";
import { existsSync } from "fs";

export const createFileTool: Tool = {
  name: "create_file",
  description: "Creates a new file with the provided content.",
  parameters: [
    { name: "path", description: "File path", required: true },
    { name: "content", description: "File content", required: true },
  ],
  async execute(args) {
    const path = args.path as string;
    const content = args.content as string;

    if (!path) throw new Error("Missing required argument: path");
    if (!content) throw new Error("Missing required argument: content");

    if (existsSync(path)) {
      throw new Error(`File already exists: ${path}`);
    }
    await Bun.write(path, content);
    return `Created file: ${path}`;
  },
};
