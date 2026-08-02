/**
 * What each tool does to the workspace.
 *
 * The tool registry does not carry this: approval is enforced inside the tool
 * implementations and in the approval policy, not declared as tool metadata.
 * It lived in site/scripts/extract.ts, which needed it to document how each
 * tool is gated. The runtime now needs the same classification to tell a turn
 * that changed files from one that only read them, and two copies of a list
 * like this is exactly how the second one goes stale.
 *
 * Keyed by tool name so an added tool reads as `unclassified` rather than
 * being silently treated as harmless.
 */
export type ToolEffect = "read" | "write" | "shell" | "ask" | "unclassified";

export const TOOL_EFFECTS: Record<string, Exclude<ToolEffect, "unclassified">> = {
  list_files: "read",
  read_file: "read",
  grep: "read",
  glob: "read",
  find_files: "read",
  web_search: "read",
  web_fetch: "read",
  create_file: "write",
  write_file: "write",
  edit_file: "write",
  run_terminal: "shell",
  run_tests: "shell",
  ask_user: "ask",
};

export function toolEffect(name: string): ToolEffect {
  return TOOL_EFFECTS[name] ?? "unclassified";
}
