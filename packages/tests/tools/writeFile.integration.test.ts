import { test, expect, describe, beforeEach, mock } from "bun:test";
import { writeFileTool } from "../../../tools/writeFile";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";

/**
 * INTEGRATION TESTS for writeFile tool
 * 
 * These tests use REAL Bun APIs with temporary files.
 * This is more reliable than mocking because:
 * 1. Bun global is readonly - can't mock it
 * 2. Real filesystem tests actual behavior
 * 3. Catches actual production bugs
 */

describe("writeFile Tool - Integration Tests", () => {
  let testDir: string;
  let mockStore: any;

  beforeEach(() => {
    // Create temp directory for this test run
    testDir = join(tmpdir(), `woop-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });

    // Mock the UI store (only thing we CAN mock)
    mockStore = {
      setPendingEdit: mock(async () => true), // Auto-approve
    };

    mock.module("../../../tui/src/store/ui-store", () => ({
      store: mockStore,
    }));
  });

  // Helper to create test file
  const createFile = async (name: string, content: string) => {
    const path = join(testDir, name);
    await Bun.write(path, content);
    return path;
  };

  // Helper to read file
  const readFile = async (path: string) => {
    return await Bun.file(path).text();
  };

  describe("Happy Path", () => {
    test("writes new content to existing file", async () => {
      const path = await createFile("test.txt", "original content");

      const result = await writeFileTool.execute({
        path,
        content: "new content",
      });

      expect(result).toBe(`Updated ${path}`);
      expect(await readFile(path)).toBe("new content");
      expect(mockStore.setPendingEdit).toHaveBeenCalledTimes(1);
    });

    test("handles identical content (no-op)", async () => {
      const path = await createFile("test.txt", "same content");

      const result = await writeFileTool.execute({
        path,
        content: "same content",
      });

      expect(result).toBe(`No changes needed for ${path}`);
      expect(mockStore.setPendingEdit).not.toHaveBeenCalled();
    });

    test("handles empty file", async () => {
      const path = await createFile("empty.txt", "");

      const result = await writeFileTool.execute({
        path,
        content: "new content",
      });

      expect(result).toBe(`Updated ${path}`);
      expect(await readFile(path)).toBe("new content");
    });

    test("handles writing empty content", async () => {
      const path = await createFile("test.txt", "original");

      const result = await writeFileTool.execute({
        path,
        content: "",
      });

      expect(result).toBe(`Updated ${path}`);
      expect(await readFile(path)).toBe("");
    });
  });

  describe("Unicode & Special Characters", () => {
    test("preserves unicode content", async () => {
      const path = await createFile("unicode.txt", "old");
      const unicode = "Hello 世界 🚀 مرحبا עברית";

      await writeFileTool.execute({
        path,
        content: unicode,
      });

      expect(await readFile(path)).toBe(unicode);
    });

    test("handles emoji", async () => {
      const path = await createFile("emoji.txt", "old");
      const emoji = "🔥💯⚡️🎉";

      await writeFileTool.execute({
        path,
        content: emoji,
      });

      expect(await readFile(path)).toBe(emoji);
    });

    test("handles newlines and tabs", async () => {
      const path = await createFile("formatted.txt", "old");
      const formatted = "line1\nline2\n\tindented\n";

      await writeFileTool.execute({
        path,
        content: formatted,
      });

      expect(await readFile(path)).toBe(formatted);
    });

    test("handles windows line endings", async () => {
      const path = await createFile("windows.txt", "old");
      const windows = "line1\r\nline2\r\n";

      await writeFileTool.execute({
        path,
        content: windows,
      });

      expect(await readFile(path)).toBe(windows);
    });
  });

  describe("Large Files", () => {
    test("handles 1MB file", async () => {
      const path = await createFile("large.txt", "old");
      const large = "x".repeat(1024 * 1024); // 1MB

      await writeFileTool.execute({
        path,
        content: large,
      });

      expect(await readFile(path)).toBe(large);
    });

    test("handles 10MB file", async () => {
      const path = await createFile("huge.txt", "old");
      const huge = "x".repeat(10 * 1024 * 1024); // 10MB

      await writeFileTool.execute({
        path,
        content: huge,
      });

      const actual = await readFile(path);
      expect(actual.length).toBe(huge.length);
    });
  });

  describe("Approval Flow", () => {
    test("rejected edit returns rejection message", async () => {
      mockStore.setPendingEdit = mock(async () => false); // Reject

      const path = await createFile("test.txt", "original");

      const result = await writeFileTool.execute({
        path,
        content: "new",
      });

      expect(result).toBe(`Edit rejected for ${path}`);
      expect(await readFile(path)).toBe("original"); // Unchanged
    });

    test("cancelled edit returns cancellation message", async () => {
      mockStore.setPendingEdit = mock(async () => {
        throw new Error("User cancelled");
      });

      const path = await createFile("test.txt", "original");

      const result = await writeFileTool.execute({
        path,
        content: "new",
      });

      expect(result).toBe(`Edit cancelled for ${path}`);
      expect(await readFile(path)).toBe("original"); // Unchanged
    });

    test("approval includes correct diff", async () => {
      const path = await createFile("test.txt", "line1\nline2\nline3");

      await writeFileTool.execute({
        path,
        content: "line1\nMODIFIED\nline3",
      });

      const call = mockStore.setPendingEdit.mock.calls[0][0];
      expect(call.filePath).toBe(path);
      expect(call.oldContent).toBe("line1\nline2\nline3");
      expect(call.newContent).toBe("line1\nMODIFIED\nline3");
      expect(call.diff).toContain("-line2");
      expect(call.diff).toContain("+MODIFIED");
    });
  });

  describe("Error Cases", () => {
    test("throws when file doesn't exist", async () => {
      const nonExistent = join(testDir, "does-not-exist.txt");

      await expect(
        writeFileTool.execute({
          path: nonExistent,
          content: "new",
        })
      ).rejects.toThrow(`File not found: ${nonExistent}`);
    });

    test("throws when path is directory", async () => {
      const dirPath = join(testDir, "subdir");
      mkdirSync(dirPath);

      await expect(
        writeFileTool.execute({
          path: dirPath,
          content: "new",
        })
      ).rejects.toThrow();
    });
  });

  describe("Idempotency", () => {
    test("same write twice produces same result", async () => {
      const path = await createFile("test.txt", "original");

      const result1 = await writeFileTool.execute({
        path,
        content: "same content",
      });

      const result2 = await writeFileTool.execute({
        path,
        content: "same content",
      });

      // Second write should be no-op
      expect(result2).toBe(`No changes needed for ${path}`);
      expect(await readFile(path)).toBe("same content");
    });
  });

  describe("Edge Cases", () => {
    test("handles file with no extension", async () => {
      const path = await createFile("noext", "old");

      await writeFileTool.execute({
        path,
        content: "new",
      });

      expect(await readFile(path)).toBe("new");
    });

    test("handles file with multiple dots", async () => {
      const path = await createFile("file.test.backup.txt", "old");

      await writeFileTool.execute({
        path,
        content: "new",
      });

      expect(await readFile(path)).toBe("new");
    });

    test("handles special characters in filename", async () => {
      const path = await createFile("file-with_special.chars.txt", "old");

      await writeFileTool.execute({
        path,
        content: "new",
      });

      expect(await readFile(path)).toBe("new");
    });
  });
});
