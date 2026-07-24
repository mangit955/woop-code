import { test, expect, describe, beforeEach } from "bun:test";
import { readFileTool } from "../../../tools/readFile";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

/**
 * INTEGRATION TESTS for readFile tool
 * 
 * Uses real Bun APIs with temporary files.
 */

describe("readFile Tool - Integration Tests", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `woop-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
  });

  const createFile = async (name: string, content: string) => {
    const path = join(testDir, name);
    await Bun.write(path, content);
    return path;
  };

  describe("Happy Path", () => {
    test("reads file content", async () => {
      const path = await createFile("test.txt", "hello world");

      const result = await readFileTool.execute({ path });

      expect(result).toBe("hello world");
    });

    test("reads empty file", async () => {
      const path = await createFile("empty.txt", "");

      const result = await readFileTool.execute({ path });

      expect(result).toBe("");
    });

    test("reads file with single line", async () => {
      const path = await createFile("single.txt", "one line");

      const result = await readFileTool.execute({ path });

      expect(result).toBe("one line");
    });

    test("reads file with multiple lines", async () => {
      const content = "line1\nline2\nline3";
      const path = await createFile("multi.txt", content);

      const result = await readFileTool.execute({ path });

      expect(result).toBe(content);
    });
  });

  describe("Unicode & Special Characters", () => {
    test("reads unicode content", async () => {
      const unicode = "Hello 世界 🚀 مرحبا עברית";
      const path = await createFile("unicode.txt", unicode);

      const result = await readFileTool.execute({ path });

      expect(result).toBe(unicode);
    });

    test("reads emoji", async () => {
      const emoji = "🔥💯⚡️🎉";
      const path = await createFile("emoji.txt", emoji);

      const result = await readFileTool.execute({ path });

      expect(result).toBe(emoji);
    });

    test("reads newlines and tabs", async () => {
      const formatted = "line1\nline2\n\tindented\n";
      const path = await createFile("formatted.txt", formatted);

      const result = await readFileTool.execute({ path });

      expect(result).toBe(formatted);
    });

    test("reads windows line endings", async () => {
      const windows = "line1\r\nline2\r\n";
      const path = await createFile("windows.txt", windows);

      const result = await readFileTool.execute({ path });

      expect(result).toBe(windows);
    });
  });

  describe("Large Files", () => {
    test("reads 1KB file fully", async () => {
      const content = "x".repeat(1024); // 1KB
      const path = await createFile("1kb.txt", content);

      const result = await readFileTool.execute({ path });

      expect(result).toBe(content);
    });

    test("reads 16KB file fully (exactly at limit)", async () => {
      const content = "x".repeat(16 * 1024); // 16KB - exactly at MAX_OUTPUT
      const path = await createFile("16kb.txt", content);

      const result = await readFileTool.execute({ path });

      expect(result).toBe(content);
    });

    test("truncates file larger than 16KB", async () => {
      const content = "x".repeat(20 * 1024); // 20KB
      const path = await createFile("20kb.txt", content);

      const result = await readFileTool.execute({ path });

      expect(result).toContain("... File truncated");
      expect(result).toContain("Showing first 16384 characters");
      expect(result.length).toBeLessThan(content.length);
    });

    test("truncates 1MB file", async () => {
      const content = "y".repeat(1024 * 1024); // 1MB
      const path = await createFile("1mb.txt", content);

      const result = await readFileTool.execute({ path });

      expect(result).toContain("... File truncated");
      expect(result).toContain("Showing first 16384 characters of 1048576");
    });

    test("truncation preserves first 16KB exactly", async () => {
      const prefix = "a".repeat(16 * 1024);
      const suffix = "b".repeat(10 * 1024);
      const content = prefix + suffix;
      const path = await createFile("mixed.txt", content);

      const result = await readFileTool.execute({ path });

      // Should contain all 'a's but no 'b's (except maybe in truncation message)
      const actualContent = result.split("\n\n... File truncated")[0];
      expect(actualContent).toBe(prefix);
      expect(actualContent).not.toContain("b");
    });
  });

  describe("Error Cases", () => {
    test("throws when file doesn't exist", async () => {
      const nonExistent = join(testDir, "does-not-exist.txt");

      await expect(
        readFileTool.execute({ path: nonExistent })
      ).rejects.toThrow(`File ${nonExistent} does not exist`);
    });

    test("throws when path is empty", async () => {
      await expect(
        readFileTool.execute({ path: "" })
      ).rejects.toThrow("File path is required");
    });

    test("throws when path is missing", async () => {
      await expect(
        readFileTool.execute({})
      ).rejects.toThrow("File path is required");
    });

    test("throws when path is directory", async () => {
      const dirPath = join(testDir, "subdir");
      mkdirSync(dirPath);

      await expect(
        readFileTool.execute({ path: dirPath })
      ).rejects.toThrow();
    });
  });

  describe("Edge Cases", () => {
    test("reads file with no extension", async () => {
      const path = await createFile("noext", "content");

      const result = await readFileTool.execute({ path });

      expect(result).toBe("content");
    });

    test("reads file with multiple dots", async () => {
      const path = await createFile("file.test.backup.txt", "content");

      const result = await readFileTool.execute({ path });

      expect(result).toBe("content");
    });

    test("reads file with whitespace-only content", async () => {
      const path = await createFile("whitespace.txt", "   \n  \t  \n   ");

      const result = await readFileTool.execute({ path });

      expect(result).toBe("   \n  \t  \n   ");
    });

    test("reads file with special characters in name", async () => {
      const path = await createFile("file-with_special.chars.txt", "content");

      const result = await readFileTool.execute({ path });

      expect(result).toBe("content");
    });
  });

  describe("Real File Types", () => {
    test("reads JSON file", async () => {
      const json = '{"name": "test", "value": 123}';
      const path = await createFile("data.json", json);

      const result = await readFileTool.execute({ path });

      expect(result).toBe(json);
    });

    test("reads JavaScript file", async () => {
      const js = 'function hello() { return "world"; }';
      const path = await createFile("code.js", js);

      const result = await readFileTool.execute({ path });

      expect(result).toBe(js);
    });

    test("reads Markdown file", async () => {
      const md = "# Title\n\nParagraph with **bold** text.";
      const path = await createFile("readme.md", md);

      const result = await readFileTool.execute({ path });

      expect(result).toBe(md);
    });

    test("reads TypeScript file", async () => {
      const ts = 'const x: number = 42;\nexport { x };';
      const path = await createFile("code.ts", ts);

      const result = await readFileTool.execute({ path });

      expect(result).toBe(ts);
    });
  });
});
