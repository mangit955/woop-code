import { terminalTool } from "./terminal";
import { readFileTool } from "./readFile";
import { listFilesTool } from "./listFiles";
import type { Tool } from "../config/types";
import { createFileTool } from "./createFile";
import { writeFileTool } from "./writeFile";
import { editFileTool } from "./editFile";
import { grepTool } from "./grep";
import { runTestsTool } from "./runTests";
import { findFilesTool } from "./findFiles";

export const toolRegistery: Tool[] = [
  listFilesTool,
  readFileTool,
  terminalTool,
  createFileTool,
  writeFileTool,
  editFileTool,
  grepTool,
  runTestsTool,
  findFilesTool,
];

export function getTool(name: string): Tool | undefined {
  return toolRegistery.find((tool) => tool.name === name);
}
