import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Approval now depends on the configured mode, so config reads go to a temp
// directory rather than the developer's real ~/.config/woopcode.
const previousConfigHome = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "woopcode-approval-"));

const { createFileTool } = await import("../../../tools/createFile");
const { terminalTool } = await import("../../../tools/terminal");
const { store } = await import("../../../tui/src/store/ui-store");
const { getConfig, saveConfig } = await import("../../../config/config");
const { ApprovalMode } = await import("../../../runtime/approval");

async function useApprovalMode(mode: string) {
  const config = await getConfig();
  config.approvalMode = mode as never;
  await saveConfig(config);
}

describe("tool approvals", () => {
  const createdFiles: string[] = [];

  afterEach(() => {
    for (const file of createdFiles.splice(0)) rmSync(file, { force: true });
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
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

  describe("with every command confirmed", () => {
    beforeEach(async () => {
      await useApprovalMode(ApprovalMode.ALWAYS_ASK);
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
      expect(requestedCommand).toMatchObject({
        command: "echo must-not-run",
        toolName: "run_terminal",
      });
    });

    test("asks even for a read-only command", async () => {
      // The original behaviour has to remain reachable exactly as it was.
      let asked = false;
      store.setPendingCommand = async () => {
        asked = true;
        return false;
      };

      await terminalTool.execute({ command: "git status" });
      expect(asked).toBe(true);
    });
  });

  describe("with reads auto-approved", () => {
    beforeEach(async () => {
      await useApprovalMode(ApprovalMode.AUTO_READ_ONLY);
    });

    test("runs a read-only command without asking", async () => {
      let asked = false;
      store.setPendingCommand = async () => {
        asked = true;
        return false;
      };

      const output = await terminalTool.execute({ command: "echo ran-without-asking" });

      expect(asked).toBe(false);
      expect(output).toContain("ran-without-asking");
    });

    test("still asks before a destructive command, and honours the refusal", async () => {
      const file = join(process.cwd(), `.approval-${crypto.randomUUID()}.txt`);
      await Bun.write(file, "keep me");
      createdFiles.push(file);

      let asked = false;
      store.setPendingCommand = async () => {
        asked = true;
        return false;
      };

      await expect(terminalTool.execute({ command: `rm -f ${file}` })).resolves.toBe(
        "Command rejected by user. It was not run.",
      );
      expect(asked).toBe(true);
      // The refusal has to actually protect the file, not just return a string.
      expect(existsSync(file)).toBe(true);
    });

    test("asks before a command that writes to the workspace", async () => {
      let asked = false;
      store.setPendingCommand = async () => {
        asked = true;
        return false;
      };

      await terminalTool.execute({ command: "mkdir -p .approval-scratch" });
      expect(asked).toBe(true);
      expect(existsSync(join(process.cwd(), ".approval-scratch"))).toBe(false);
    });
  });
});
