import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { readFileTool } from "../../../tools/readFile";
import { createFileTool } from "../../../tools/createFile";
import { listFilesTool } from "../../../tools/listFiles";

describe("workspace path guard", () => {
  test("rejects lexical escapes for local tools", async () => {
    await expect(readFileTool.execute({ path: "../package.json" })).rejects.toThrow(
      "Path escapes the workspace",
    );
    await expect(createFileTool.execute({ path: "../outside.txt", content: "nope" })).rejects.toThrow(
      "Path escapes the workspace",
    );
    await expect(listFilesTool.execute({ path: "../" })).rejects.toThrow(
      "Path escapes the workspace",
    );
  });

  test("rejects symlinks whose destination is outside the workspace", async () => {
    const directory = join(process.cwd(), `.workspace-guard-${crypto.randomUUID()}`);
    const link = join(directory, "outside-link");
    mkdirSync(directory);
    symlinkSync("/tmp", link);

    try {
      await expect(readFileTool.execute({ path: join(link, "anything") })).rejects.toThrow(
        "Path escapes the workspace",
      );
      await expect(createFileTool.execute({ path: join(link, "new-file"), content: "nope" })).rejects.toThrow(
        "Path escapes the workspace",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
