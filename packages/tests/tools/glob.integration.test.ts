import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { globTool } from "../../../tools/glob";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";

describe("glob tool - integration tests", () => {
  let testDir: string;

  beforeEach(async () => {
    // Create unique test directory
    testDir = join(process.cwd(), `.glob-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Create test file structure
    await Bun.write(join(testDir, "file1.ts"), "// test file 1");
    await Bun.write(join(testDir, "file2.ts"), "// test file 2");
    await Bun.write(join(testDir, "file3.js"), "// test file 3");
    await Bun.write(join(testDir, "readme.md"), "# readme");
    
    // Create subdirectory
    mkdirSync(join(testDir, "src"), { recursive: true });
    await Bun.write(join(testDir, "src", "app.ts"), "// app");
    await Bun.write(join(testDir, "src", "utils.ts"), "// utils");
    
    // Create nested subdirectory
    mkdirSync(join(testDir, "src", "components"), { recursive: true });
    await Bun.write(join(testDir, "src", "components", "Button.tsx"), "// button");
  });

  afterEach(() => {
    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe("basic pattern matching", () => {
    test("finds all TypeScript files with *.ts", async () => {
      const result = await globTool.execute({
        pattern: "*.ts",
        path: testDir,
      });

      expect(result).toContain("file1.ts");
      expect(result).toContain("file2.ts");
      expect(result).not.toContain("file3.js");
      expect(result).not.toContain("readme.md");
    });

    test("finds all files with *", async () => {
      const result = await globTool.execute({
        pattern: "*",
        path: testDir,
      });

      expect(result).toContain("file1.ts");
      expect(result).toContain("file2.ts");
      expect(result).toContain("file3.js");
      expect(result).toContain("readme.md");
    });

    test("finds files with specific extension using *.ext", async () => {
      const result = await globTool.execute({
        pattern: "*.md",
        path: testDir,
      });

      expect(result).toContain("readme.md");
      expect(result).not.toContain("file1.ts");
    });
  });

  describe("recursive pattern matching", () => {
    test("finds all TypeScript files recursively with **/*.ts", async () => {
      const result = await globTool.execute({
        pattern: "**/*.ts",
        path: testDir,
      });

      expect(result).toContain("file1.ts");
      expect(result).toContain("file2.ts");
      expect(result).toContain(join("src", "app.ts"));
      expect(result).toContain(join("src", "utils.ts"));
    });

    test("finds all files recursively with **/*", async () => {
      const result = await globTool.execute({
        pattern: "**/*",
        path: testDir,
      });

      expect(result).toContain("file1.ts");
      expect(result).toContain(join("src", "app.ts"));
      expect(result).toContain(join("src", "components", "Button.tsx"));
    });

    test("finds TypeScript and TSX files with **/*.{ts,tsx}", async () => {
      const result = await globTool.execute({
        pattern: "**/*.{ts,tsx}",
        path: testDir,
      });

      expect(result).toContain("file1.ts");
      expect(result).toContain(join("src", "app.ts"));
      expect(result).toContain(join("src", "components", "Button.tsx"));
      expect(result).not.toContain("file3.js");
    });
  });

  describe("directory-specific patterns", () => {
    test("finds files in specific subdirectory", async () => {
      const result = await globTool.execute({
        pattern: "src/*.ts",
        path: testDir,
      });

      expect(result).toContain(join("src", "app.ts"));
      expect(result).toContain(join("src", "utils.ts"));
      expect(result).not.toContain("file1.ts"); // Not in src/
      expect(result).not.toContain(join("src", "components", "Button.tsx")); // In subdirectory
    });

    test("finds files in nested directory", async () => {
      const result = await globTool.execute({
        pattern: "src/components/*.tsx",
        path: testDir,
      });

      expect(result).toContain(join("src", "components", "Button.tsx"));
      expect(result).not.toContain(join("src", "app.ts"));
    });
  });

  describe("edge cases", () => {
    test("returns 'No files found' for non-matching pattern", async () => {
      const result = await globTool.execute({
        pattern: "*.xyz",
        path: testDir,
      });

      expect(result).toBe("No files found");
    });

    test("uses current working directory when path not specified", async () => {
      const result = await globTool.execute({
        pattern: "package.json",
      });

      // Should find package.json in repo root
      expect(result).toContain("package.json");
    });

    test("throws error when pattern is empty", async () => {
      expect(
        globTool.execute({ pattern: "" })
      ).rejects.toThrow("Pattern is required");
    });

    test("rejects paths outside the workspace", async () => {
      await expect(
        globTool.execute({ pattern: "*.json", path: "../" }),
      ).rejects.toThrow("Path escapes the workspace");
    });
  });

  describe("truncation", () => {
    test("truncates results at 100 files", async () => {
      // Create 120 files
      for (let i = 0; i < 120; i++) {
        await Bun.write(join(testDir, `file${i}.txt`), `content ${i}`);
      }

      const result = await globTool.execute({
        pattern: "*.txt",
        path: testDir,
      });

      // Count number of lines (files)
      const lines = result.split("\n");
      const fileLines = lines.filter(line => !line.startsWith("(") && line.trim());
      
      expect(fileLines.length).toBeLessThanOrEqual(100);
      expect(result).toContain("Results are truncated");
      expect(result).toContain("showing first 100 results");
    });

    test("does not show truncation message for < 100 files", async () => {
      const result = await globTool.execute({
        pattern: "**/*",
        path: testDir,
      });

      expect(result).not.toContain("Results are truncated");
    });
  });

  describe("absolute paths", () => {
    test("returns absolute paths for matched files", async () => {
      const result = await globTool.execute({
        pattern: "*.ts",
        path: testDir,
      });

      const lines = result.split("\n");
      lines.forEach(line => {
        if (line && !line.startsWith("(")) {
          expect(line).toContain(testDir);
        }
      });
    });
  });

  describe("error handling", () => {
    test("throws error if path is a file, not directory", async () => {
      const filePath = join(testDir, "file1.ts");

      await expect(
        globTool.execute({ pattern: "*.ts", path: filePath })
      ).rejects.toThrow("glob path must be a directory");
    });

    test("handles invalid patterns gracefully", async () => {
      // Bun.Glob should handle invalid patterns
      const result = await globTool.execute({
        pattern: "[invalid",
        path: testDir,
      });

      // Should not crash, might return no results
      expect(typeof result).toBe("string");
    });
  });
});
