import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createFileTool } from "../../../tools/createFile";
import { terminalTool } from "../../../tools/terminal";
import { store } from "../../../tui/src/store/ui-store";

describe("tool approvals", () => {
  const createdFiles: string[] = [];

  afterEach(() => {
    for (const file of createdFiles.splice(0)) rmSync(file, { force: true });
  });

  test("does not create a file when its diff is rejected", async () => {
    const file = join(process.cwd(), `.approval-${crypto.randomUUID()}.txt`);
    createdFiles.push(file);
    let pendingEdit: unknown;
    store.setPendingEdit = async (edit: unknown) => {
      pendingEdit = edit;
      return false;
    };

    await expect(createFileTool.execute({ path: file, content: "new file" })).resolves.toBe(
      `Create rejected for ${file}. No file was created.`,
    );
    expect(pendingEdit).toMatchObject({ filePath: file, oldContent: "", newContent: "new file" });
    expect(existsSync(file)).toBe(false);
  });

  test("does not execute a rejected command", async () => {
    let requestedCommand: unknown;
    store.setPendingCommand = async (command: unknown) => {
      requestedCommand = command;
      return false;
    };

    await expect(terminalTool.execute({ command: "echo must-not-run" })).resolves.toBe(
      "Command rejected by user. It was not run.",
    );
    expect(requestedCommand).toMatchObject({ command: "echo must-not-run", toolName: "run_terminal" });
  });
});
