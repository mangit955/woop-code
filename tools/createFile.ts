import type { Tool } from "../config/types";
import { existsSync } from "fs";
import { resolveWorkspacePath } from "./workspace";

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
    await Bun.write(path, content);
    return `Created file: ${path}`;
  },
};
