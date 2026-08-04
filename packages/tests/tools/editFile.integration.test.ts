import { test, expect, describe, beforeAll, beforeEach, afterAll, afterEach, mock } from "bun:test";
import { editFileTool } from "../../../tools/editFile";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";

/**
 * INTEGRATION TESTS for editFile tool
 * 
 * Uses real Bun APIs with temporary files.
 */

// Registered once, against one object that never changes identity. A module
// mock is global to the whole run, and a tool captures `store` the first time it
// is imported — so handing out a fresh object each test leaves that tool holding
// a store nobody can patch afterwards. Test methods are reset in place instead.
const mockStore: any = {};

// ...and inert outside this file. The stub used to replace the module outright,
// which left every file that ran afterwards holding a store with five methods on
// it: `todo_write`'s tests failed on `clearTimeline` being undefined, and only in
// a full run. While `intercepting` is off, every property comes from the real
// store, so the order files run in stops mattering. The whole module is spread
// too, or `UIStore` and `READY_STATUS` vanish for everyone else.
const actualStore = await import("../../../tui/src/store/ui-store");
let intercepting = false;

const storeStub = new Proxy(actualStore.store, {
  get(target, property, receiver) {
    if (intercepting && property in mockStore) return mockStore[property];
    return Reflect.get(target, property, receiver);
  },
});

mock.module("../../../tui/src/store/ui-store", () => ({
  ...actualStore,
  store: storeStub,
}));

beforeAll(() => {
  intercepting = true;
});

afterAll(() => {
  intercepting = false;
});

describe("editFile Tool - Integration Tests", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(process.cwd(), `.woop-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });

    Object.assign(mockStore, {
      setPendingEdit: mock(async () => true), // Auto-approve
      setPendingCommand: mock(async () => true),
      setPendingQuestion: mock(async () => []),
      addSystemMessage: mock(() => {}),
      setSelectedModel: mock(() => {}),
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const createFile = async (name: string, content: string) => {
    const path = join(testDir, name);
    await Bun.write(path, content);
    return path;
  };

  const readFile = async (path: string) => {
    return await Bun.file(path).text();
  };

  describe("Happy Path", () => {
    test("replaces text in file", async () => {
      const path = await createFile("test.txt", "hello world");

      const result = await editFileTool.execute({
        path,
        oldText: "world",
        newText: "universe",
      });

      expect(result).toBe(`Edited ${path}`);
      expect(await readFile(path)).toBe("hello universe");
    });

    test("refuses an ambiguous match instead of taking the first", async () => {
      // This tool used to replace the first occurrence silently, which is a
      // guess about which one the caller meant.
      const path = await createFile("test.txt", "hello world world");

      await expect(
        editFileTool.execute({
          path,
          oldText: "world",
          newText: "universe",
        }),
      ).rejects.toThrow("Found 2 matches");

      expect(await readFile(path)).toBe("hello world world");
      expect(mockStore.setPendingEdit).not.toHaveBeenCalled();
    });

    test("replaces every occurrence when replaceAll is set", async () => {
      const path = await createFile("test.txt", "hello world world");

      const result = await editFileTool.execute({
        path,
        oldText: "world",
        newText: "universe",
        replaceAll: true,
      });

      expect(result).toBe(`Edited ${path} (2 occurrences replaced)`);
      expect(await readFile(path)).toBe("hello universe universe");
    });

    test("replaces entire line", async () => {
      const path = await createFile("test.txt", "line1\nline2\nline3");

      await editFileTool.execute({
        path,
        oldText: "line2",
        newText: "MODIFIED",
      });

      expect(await readFile(path)).toBe("line1\nMODIFIED\nline3");
    });

    test("replaces multiline text", async () => {
      const path = await createFile("test.txt", "line1\nline2\nline3");

      await editFileTool.execute({
        path,
        oldText: "line2\nline3",
        newText: "REPLACEMENT",
      });

      expect(await readFile(path)).toBe("line1\nREPLACEMENT");
    });

    test("inserts text by replacing empty string", async () => {
      const path = await createFile("test.txt", "start end");

      await editFileTool.execute({
        path,
        oldText: " ",
        newText: " middle ",
      });

      expect(await readFile(path)).toBe("start middle end");
    });

    test("deletes text by replacing with empty string", async () => {
      const path = await createFile("test.txt", "hello world");

      await editFileTool.execute({
        path,
        oldText: " world",
        newText: "",
      });

      expect(await readFile(path)).toBe("hello");
    });
  });

  describe("Unicode & Special Characters", () => {
    test("replaces unicode text", async () => {
      const path = await createFile("unicode.txt", "Hello 世界");

      await editFileTool.execute({
        path,
        oldText: "世界",
        newText: "🌍",
      });

      expect(await readFile(path)).toBe("Hello 🌍");
    });

    test("replaces emoji", async () => {
      const path = await createFile("emoji.txt", "Status: 🔥");

      await editFileTool.execute({
        path,
        oldText: "🔥",
        newText: "✅",
      });

      expect(await readFile(path)).toBe("Status: ✅");
    });

    test("handles special regex characters in oldText", async () => {
      const path = await createFile("regex.txt", "price: $100");

      await editFileTool.execute({
        path,
        oldText: "$100",
        newText: "$200",
      });

      expect(await readFile(path)).toBe("price: $200");
    });

    test("handles newlines in replacement", async () => {
      const path = await createFile("test.txt", "single line");

      await editFileTool.execute({
        path,
        oldText: " ",
        newText: "\n",
      });

      expect(await readFile(path)).toBe("single\nline");
    });
  });

  describe("Approval Flow", () => {
    test("rejected edit returns rejection message", async () => {
      mockStore.setPendingEdit = mock(async () => false);

      const path = await createFile("test.txt", "original");

      const result = await editFileTool.execute({
        path,
        oldText: "original",
        newText: "new",
      });

      expect(result).toBe(`Edit rejected for ${path}. No changes were applied. Do not claim this edit was completed.`);
      expect(await readFile(path)).toBe("original"); // Unchanged
      expect(mockStore.addSystemMessage).toHaveBeenCalledWith(
        `Edit rejected for ${path}. No changes were applied. Do not claim this edit was completed.`,
      );
    });

    test("cancelled edit returns cancellation message", async () => {
      mockStore.setPendingEdit = mock(async () => {
        throw new Error("User cancelled");
      });

      const path = await createFile("test.txt", "original");

      const result = await editFileTool.execute({
        path,
        oldText: "original",
        newText: "new",
      });

      expect(result).toBe(`Edit cancelled for ${path}. No changes were applied.`);
      expect(await readFile(path)).toBe("original"); // Unchanged
      expect(mockStore.addSystemMessage).toHaveBeenCalledWith(
        `Edit cancelled for ${path}. No changes were applied.`,
      );
    });

    test("approval includes correct diff", async () => {
      const path = await createFile("test.txt", "line1\nline2\nline3");

      await editFileTool.execute({
        path,
        oldText: "line2",
        newText: "MODIFIED",
      });

      const call = mockStore.setPendingEdit.mock.calls[0][0];
      expect(call.filePath).toBe(path);
      expect(call.oldContent).toBe("line1\nline2\nline3");
      expect(call.newContent).toBe("line1\nMODIFIED\nline3");
      expect(call.diff).toContain("-line2");
      expect(call.diff).toContain("+MODIFIED");
    });

    test("no changes needed when replacement produces identical content", async () => {
      const path = await createFile("test.txt", "hello");

      const result = await editFileTool.execute({
        path,
        oldText: "hello",
        newText: "hello",
      });

      expect(result).toBe(`No changes needed for ${path}`);
      expect(mockStore.setPendingEdit).not.toHaveBeenCalled();
    });
  });

  describe("Error Cases", () => {
    test("throws when file doesn't exist", async () => {
      const nonExistent = join(testDir, "does-not-exist.txt");

      await expect(
        editFileTool.execute({
          path: nonExistent,
          oldText: "old",
          newText: "new",
        })
      ).rejects.toThrow(`File not found: ${nonExistent}`);
    });

    // The arguments arrive from a language model, so an omitted one is a
    // routine occurrence rather than a programmer error. `newText` was cast
    // straight to string and handed to applyEdit, which splices it into the
    // rebuilt file with `join("")` — and join renders undefined as empty. So a
    // missing newText silently *deleted* the matched text and reported
    // "Edited <path>" as success. Visible on the diff when someone is watching
    // one; applied unseen under --prompt or full-auto.
    test("refuses a missing newText instead of silently deleting", async () => {
      const path = await createFile("test.txt", "hello world");

      await expect(
        editFileTool.execute({ path, oldText: "world" }),
      ).rejects.toThrow("Missing required argument: newText");

      expect(await readFile(path)).toBe("hello world");
    });

    test("refuses a missing oldText", async () => {
      const path = await createFile("test.txt", "hello world");

      await expect(
        editFileTool.execute({ path, newText: "universe" }),
      ).rejects.toThrow("Missing required argument: oldText");

      expect(await readFile(path)).toBe("hello world");
    });

    // Deletion. `typeof` rather than truthiness is what keeps this working:
    // "" is a legitimate replacement, and the same distinction createFile
    // already draws for an empty file.
    test("accepts an empty newText as a deletion", async () => {
      const path = await createFile("test.txt", "hello world");

      await editFileTool.execute({ path, oldText: " world", newText: "" });

      expect(await readFile(path)).toBe("hello");
    });

    test("throws when oldText not found in file", async () => {
      const path = await createFile("test.txt", "hello world");

      await expect(
        editFileTool.execute({
          path,
          oldText: "nonexistent",
          newText: "new",
        })
      ).rejects.toThrow("Text to replace not found");
    });

    test("ambiguity error carries every match in context", async () => {
      const path = await createFile(
        "api.ts",
        [
          "function load() {",
          "  const result = fetchUser(id);",
          "  return result;",
          "}",
          "",
          "function reload() {",
          "  const result = fetchUser(id);",
          "  return result;",
          "}",
        ].join("\n"),
      );

      const failure = await editFileTool
        .execute({ path, oldText: "const result = fetchUser(id);", newText: "x" })
        .catch((error: Error) => error.message);

      // Everything needed to extend oldText, without reading the file again.
      expect(failure).toContain(`Found 2 matches for oldText in ${path} (lines 2, 7).`);
      expect(failure).toContain("Line 2, column 3:");
      expect(failure).toContain("  1 | function load() {");
      expect(failure).toContain("> 2 |   const result = fetchUser(id);");
      expect(failure).toContain("  6 | function reload() {");
      expect(failure).toContain("Extend oldText");
    });

    test("throws when oldText is empty", async () => {
      const path = await createFile("test.txt", "hello world");

      await expect(
        editFileTool.execute({ path, oldText: "", newText: "X" }),
      ).rejects.toThrow("oldText must not be empty");

      expect(await readFile(path)).toBe("hello world");
    });

    test("a replaceAll of false is not a request to replace all", async () => {
      const path = await createFile("test.txt", "foo foo");

      await expect(
        editFileTool.execute({ path, oldText: "foo", newText: "bar", replaceAll: false }),
      ).rejects.toThrow("Found 2 matches");

      expect(await readFile(path)).toBe("foo foo");
    });

    test("newText is inserted literally, not as a substitution pattern", async () => {
      const path = await createFile("test.sh", "cost=PLACEHOLDER");

      await editFileTool.execute({
        path,
        oldText: "PLACEHOLDER",
        newText: "$&{total}",
      });

      expect(await readFile(path)).toBe("cost=$&{total}");
    });

    test("throws when path is directory", async () => {
      const dirPath = join(testDir, "subdir");
      mkdirSync(dirPath);

      await expect(
        editFileTool.execute({
          path: dirPath,
          oldText: "old",
          newText: "new",
        })
      ).rejects.toThrow();
    });
  });

  describe("Edge Cases", () => {
    test("handles file with no extension", async () => {
      const path = await createFile("noext", "content");

      await editFileTool.execute({
        path,
        oldText: "content",
        newText: "modified",
      });

      expect(await readFile(path)).toBe("modified");
    });

    test("handles empty file", async () => {
      const path = await createFile("empty.txt", "");

      await expect(
        editFileTool.execute({
          path,
          oldText: "anything",
          newText: "new",
        })
      ).rejects.toThrow("Text to replace not found");
    });

    test("handles replacing entire file content", async () => {
      const path = await createFile("test.txt", "entire content");

      await editFileTool.execute({
        path,
        oldText: "entire content",
        newText: "completely different",
      });

      expect(await readFile(path)).toBe("completely different");
    });

    test("handles whitespace-sensitive replacement", async () => {
      const path = await createFile("test.txt", "hello  world");

      await editFileTool.execute({
        path,
        oldText: "  ",
        newText: " ",
      });

      expect(await readFile(path)).toBe("hello world");
    });
  });

  describe("Real-World Scenarios", () => {
    test("updates function name in JavaScript", async () => {
      const js = 'function oldName() {\n  return "value";\n}';
      const path = await createFile("code.js", js);

      await editFileTool.execute({
        path,
        oldText: "function oldName()",
        newText: "function newName()",
      });

      const result = await readFile(path);
      expect(result).toContain("function newName()");
      expect(result).not.toContain("function oldName()");
    });

    test("updates import statement", async () => {
      const ts = 'import { old } from "./module";';
      const path = await createFile("code.ts", ts);

      await editFileTool.execute({
        path,
        oldText: 'import { old }',
        newText: 'import { newImport }',
      });

      expect(await readFile(path)).toBe('import { newImport } from "./module";');
    });

    test("updates JSON value", async () => {
      const json = '{\n  "key": "oldValue"\n}';
      const path = await createFile("data.json", json);

      await editFileTool.execute({
        path,
        oldText: '"oldValue"',
        newText: '"newValue"',
      });

      expect(await readFile(path)).toContain('"newValue"');
    });

    test("fixes typo in documentation", async () => {
      const md = "# Title\n\nThis is a documnetation file.";
      const path = await createFile("README.md", md);

      await editFileTool.execute({
        path,
        oldText: "documnetation",
        newText: "documentation",
      });

      expect(await readFile(path)).toContain("documentation file");
    });

    test("updates version number", async () => {
      const pkg = '{\n  "version": "1.0.0"\n}';
      const path = await createFile("package.json", pkg);

      await editFileTool.execute({
        path,
        oldText: '"1.0.0"',
        newText: '"1.0.1"',
      });

      expect(await readFile(path)).toContain('"1.0.1"');
    });
  });

  describe("Idempotency", () => {
    test("second identical edit is no-op", async () => {
      const path = await createFile("test.txt", "hello world");

      await editFileTool.execute({
        path,
        oldText: "world",
        newText: "universe",
      });

      // Reset mock
      mockStore.setPendingEdit.mockClear();

      // Try same edit again - but oldText no longer exists
      await expect(
        editFileTool.execute({
          path,
          oldText: "world",
          newText: "universe",
        })
      ).rejects.toThrow("Text to replace not found");
    });
  });

  describe("Large Files", () => {
    test("edits large file (1MB)", async () => {
      const prefix = "START\n";
      const content = prefix + "x".repeat(1024 * 1024) + "\nEND";
      const path = await createFile("large.txt", content);

      await editFileTool.execute({
        path,
        oldText: "START",
        newText: "MODIFIED",
      });

      const result = await readFile(path);
      expect(result).toStartWith("MODIFIED\n");
    });
  });
});
