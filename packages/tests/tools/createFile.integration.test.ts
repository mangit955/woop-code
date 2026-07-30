import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import type { PendingEdit } from "../../../tui/src/types";

// Only the approval prompt is faked. Everything else on the store stays real,
// so this mock cannot break other files in the run the way a partial stub can.
const { store: realStore } = await import("../../../tui/src/store/ui-store");

let approve = true;
let lastPendingEdit: PendingEdit | null = null;

const storeStub = new Proxy(realStore, {
  get(target, property, receiver) {
    if (property === "setPendingEdit") {
      return async (edit: PendingEdit) => {
        lastPendingEdit = edit;
        return approve;
      };
    }
    return Reflect.get(target, property, receiver);
  },
});

mock.module("../../../tui/src/store/ui-store", () => ({ store: storeStub }));

const { createFileTool } = await import("../../../tools/createFile");
const { writeFileTool } = await import("../../../tools/writeFile");

describe("create_file", () => {
  let testDir: string;

  beforeEach(() => {
    approve = true;
    lastPendingEdit = null;
    testDir = join(process.cwd(), `.create-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("creates an empty file when content is an empty string", async () => {
    const path = join(testDir, ".gitkeep");

    const result = await createFileTool.execute({ path, content: "" }, undefined as any);

    expect(result).toContain("Created file");
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBe(0);
  });

  test("the empty-file preview says what will be created", async () => {
    await createFileTool.execute({ path: join(testDir, "empty.ts"), content: "" }, undefined as any);

    // A header-only patch shows no +/- lines, so the note is the only thing
    // telling the user what they are approving.
    expect(lastPendingEdit?.diff).toContain("(new empty file)");
  });

  test("still creates a file with content", async () => {
    const path = join(testDir, "app.ts");

    await createFileTool.execute({ path, content: "export const a = 1;\n" }, undefined as any);

    expect(await Bun.file(path).text()).toBe("export const a = 1;\n");
    expect(lastPendingEdit?.diff).not.toContain("(new empty file)");
  });

  test("a missing content argument is still an error", async () => {
    await expect(
      createFileTool.execute({ path: join(testDir, "nope.ts") }, undefined as any),
    ).rejects.toThrow("Missing required argument: content");
  });

  test("a non-string content argument is rejected", async () => {
    await expect(
      createFileTool.execute({ path: join(testDir, "nope.ts"), content: 42 }, undefined as any),
    ).rejects.toThrow("must be a string");
  });

  test("a missing path is still an error", async () => {
    await expect(
      createFileTool.execute({ content: "" }, undefined as any),
    ).rejects.toThrow("Missing required argument: path");
  });

  test("a rejected empty file is not written", async () => {
    approve = false;
    const path = join(testDir, "rejected.txt");

    const result = await createFileTool.execute({ path, content: "" }, undefined as any);

    expect(result).toContain("Create rejected");
    expect(existsSync(path)).toBe(false);
  });

  test("refuses to overwrite an existing file", async () => {
    const path = join(testDir, "exists.txt");
    writeFileSync(path, "original");

    await expect(
      createFileTool.execute({ path, content: "" }, undefined as any),
    ).rejects.toThrow("File already exists");
  });
});

describe("write_file argument validation", () => {
  let testDir: string;

  beforeEach(() => {
    approve = true;
    testDir = join(process.cwd(), `.write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("truncating a file to empty is allowed", async () => {
    const path = join(testDir, "notes.txt");
    writeFileSync(path, "some content");

    await writeFileTool.execute({ path, content: "" }, undefined as any);

    expect(statSync(path).size).toBe(0);
  });

  test("a missing content argument is rejected before writing", async () => {
    const path = join(testDir, "notes.txt");
    writeFileSync(path, "some content");

    await expect(writeFileTool.execute({ path }, undefined as any)).rejects.toThrow(
      "Missing required argument: content",
    );
    expect(await Bun.file(path).text()).toBe("some content");
  });
});
