import { terminalTool } from "./terminal";
import { readFileTool } from "./readFile";
import { listFilesTool } from "./listFiles";
import type { Tool } from "../config/types";

export const toolRegistery: Tool[] = [
  listFilesTool,
  readFileTool,
  terminalTool,
];

export function getTool(name: string): Tool | undefined {
  return toolRegistery.find((tool) => tool.name === name);
}
