import { test, expect, describe, beforeEach, mock } from "bun:test";
import { editFileTool } from "../../../tools/editFile";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

/**
 * INTEGRATION TESTS for editFile tool
 * 
 * Uses real Bun APIs with temporary files.
 */

describe("editFile Tool - Integration Tests", () => {
  let testDir: string;
  let mockStore: any;

  beforeEach(() => {
    testDir = join(tmpdir(), `woop-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });

    mockStore = {
      setPendingEdit: mock(async () => true), // Auto-approve
    };

    mock.module("../../../tui/src/store/ui-store", () => ({
      store: mockStore,
    }));
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

    test("replaces first occurrence only", async () => {
      const path = await createFile("test.txt", "hello world world");

      await editFileTool.execute({
        path,
        oldText: "world",
        newText: "universe",
      });

      expect(await readFile(path)).toBe("hello universe world");
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

      expect(result).toBe(`Edit rejected for ${path}`);
      expect(await readFile(path)).toBe("original"); // Unchanged
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

      expect(result).toBe(`Edit cancelled for ${path}`);
      expect(await readFile(path)).toBe("original"); // Unchanged
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
