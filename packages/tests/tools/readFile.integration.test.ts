import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readFileTool } from "../../../tools/readFile";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";

/**
 * INTEGRATION TESTS for readFile tool
 * 
 * Uses real Bun APIs with temporary files.
 */

describe("readFile Tool - Integration Tests", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(process.cwd(), `.woop-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
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

  describe("Line ranges", () => {
    const numbered = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

    test("reads an inclusive range", async () => {
      const path = await createFile("r.txt", numbered);
      const result = await readFileTool.execute({ path, startLine: 5, endLine: 8 });

      // Inclusive at both ends: an agent told an error is on line 8 and asking
      // for 5-8 must be given line 8.
      expect(result).toContain("line 5");
      expect(result).toContain("line 8");
      expect(result).not.toContain("line 4");
      expect(result).not.toContain("line 9");
    });

    test("says which lines were returned and how many there are", async () => {
      const path = await createFile("r.txt", numbered);
      const result = await readFileTool.execute({ path, startLine: 5, endLine: 8 });

      expect(result).toStartWith("Lines 5-8 of 20 in ");
    });

    test("startLine alone reads to the end", async () => {
      const path = await createFile("r.txt", numbered);
      const result = await readFileTool.execute({ path, startLine: 18 });

      expect(result).toContain("line 20");
      expect(result).not.toContain("line 17");
    });

    test("endLine alone reads from the start", async () => {
      const path = await createFile("r.txt", numbered);
      const result = await readFileTool.execute({ path, endLine: 3 });

      expect(result).toContain("line 1");
      expect(result).not.toContain("line 4");
    });

    test("an endLine past the file is clamped rather than failing", async () => {
      const path = await createFile("r.txt", numbered);
      const result = await readFileTool.execute({ path, startLine: 19, endLine: 999 });

      expect(result).toStartWith("Lines 19-20 of 20 in ");
    });

    test("a range reaches the end of a file too large to read whole", async () => {
      // The gap this closes: the whole-file path cuts at 16 KB from the head,
      // so without a range the end of a large file cannot be seen at all.
      const big = Array.from({ length: 5_000 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`).join("\n");
      const path = await createFile("big.txt", big);

      const whole = await readFileTool.execute({ path });
      expect(whole).toContain("... File truncated");
      expect(whole).not.toContain("line 5000 ");

      const tail = await readFileTool.execute({ path, startLine: 4_998 });
      expect(tail).toContain("line 5000 ");
    });

    test("a startLine past the end says so", async () => {
      const path = await createFile("r.txt", numbered);
      await expect(
        readFileTool.execute({ path, startLine: 99 }),
      ).rejects.toThrow(/past the end/);
    });

    test("a reversed range is rejected", async () => {
      const path = await createFile("r.txt", numbered);
      await expect(
        readFileTool.execute({ path, startLine: 9, endLine: 4 }),
      ).rejects.toThrow(/must not be before/);
    });

    test.each([0, -3, 2.5, "abc"])("rejects %p as a line number", async (value) => {
      const path = await createFile("r.txt", numbered);
      await expect(
        readFileTool.execute({ path, startLine: value }),
      ).rejects.toThrow(/whole number/);
    });

    test("numbers arriving as strings are accepted", async () => {
      // Providers vary in whether a numeric argument survives as a number.
      const path = await createFile("r.txt", numbered);
      const result = await readFileTool.execute({ path, startLine: "5", endLine: "6" });

      expect(result).toContain("line 5");
      expect(result).not.toContain("line 7");
    });

    test("a whole-file read is still returned verbatim", async () => {
      // edit_file requires oldText copied exactly from a read_file result, so
      // the unranged path must not gain a header.
      const path = await createFile("r.txt", numbered);
      expect(await readFileTool.execute({ path })).toBe(numbered);
    });

    test("a trailing newline is not counted as an extra line", async () => {
      const path = await createFile("r.txt", "a\nb\nc\n");
      expect(await readFileTool.execute({ path, startLine: 1 })).toStartWith(
        "Lines 1-3 of 3 in ",
      );
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
      expect(result).toContain("first 16384 of");
      expect(result).toContain("startLine and endLine");
      expect(result.length).toBeLessThan(content.length);
    });

    test("truncates 1MB file", async () => {
      const content = "y".repeat(1024 * 1024); // 1MB
      const path = await createFile("1mb.txt", content);

      const result = await readFileTool.execute({ path });

      expect(result).toContain("... File truncated");
      expect(result).toContain("first 16384 of 1048576 characters");
      // The message names the way out, so an agent that needs the rest of the
      // file can ask for it instead of re-reading the same head.
      expect(result).toContain("startLine and endLine");
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
