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
import { globTool } from "./glob";
import { webSearchTool } from "./webSearch";
import { webFetchTool } from "./webFetch";
import { questionTool } from "./question";
import { todoWriteTool } from "./todo";

export const toolRegistry: Tool[] = [
  listFilesTool,
  readFileTool,
  terminalTool,
  createFileTool,
  writeFileTool,
  editFileTool,
  grepTool,
  runTestsTool,
  findFilesTool,
  globTool,
  webSearchTool,
  webFetchTool,
  questionTool,
  todoWriteTool,
];

// Providers occasionally vary casing or use the singular form while selecting a
// tool. Keep the public schema canonical, but accept the names emitted by older
// prompts and providers so an otherwise valid call can complete.
const toolAliases: Record<string, string> = {
  list_file: "list_files",
  list_Files: "list_files",
  "list-files": "list_files",
};

/** Resolve a provider-facing tool name against a registry. */
export function resolveTool(
  name: string,
  registry: readonly Tool[] = toolRegistry,
): Tool | undefined {
  const canonicalName = toolAliases[name] ?? name;
  return registry.find((tool) => tool.name === canonicalName);
}

export function getTool(name: string): Tool | undefined {
  return resolveTool(name);
}
