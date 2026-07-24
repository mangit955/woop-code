import { test, expect, describe } from "bun:test";
import { terminalTool } from "../../../tools/terminal";

/**
 * INTEGRATION TESTS for terminal tool
 * 
 * These tests use REAL Bun.spawn with actual shell commands.
 * This is the only way to properly test terminal tool because:
 * 1. Bun.spawn can't be mocked (readonly global)
 * 2. Real process execution tests actual behavior
 * 3. Shell behavior varies - need real shell to test
 */

describe("terminal Tool - Integration Tests", () => {
  describe("Basic Execution", () => {
    test("executes simple command", async () => {
      const result = await terminalTool.execute({
        command: "echo hello",
      });

      expect(result).toBe("hello\n");
    });

    test("returns stdout", async () => {
      const result = await terminalTool.execute({
        command: "echo 'test output'",
      });

      expect(result).toContain("test output");
    });

    test("handles multiline output", async () => {
      const result = await terminalTool.execute({
        command: "echo 'line1'; echo 'line2'",
      });

      expect(result).toContain("line1");
      expect(result).toContain("line2");
    });

    test("handles empty output", async () => {
      const result = await terminalTool.execute({
        command: "true", // Exits 0, no output
      });

      expect(result).toBe("");
    });
  });

  describe("Error Handling", () => {
    test("returns stderr when command fails", async () => {
      const result = await terminalTool.execute({
        command: "ls /nonexistent-directory-xyz-123",
      });

      // Should return stderr (error message)
      expect(result).toContain("No such file or directory");
    });

    test("handles command not found", async () => {
      const result = await terminalTool.execute({
        command: "nonexistent-command-xyz-123",
      });

      expect(result).toContain("not found");
    });

    test("throws when command is empty", async () => {
      await expect(
        terminalTool.execute({ command: "" })
      ).rejects.toThrow("command is required");
    });

    test("throws when command is missing", async () => {
      await expect(
        terminalTool.execute({})
      ).rejects.toThrow("command is required");
    });
  });

  describe("Shell Features", () => {
    test("handles pipes", async () => {
      const result = await terminalTool.execute({
        command: "echo 'hello world' | grep hello",
      });

      expect(result).toContain("hello");
    });

    test("handles command chaining with &&", async () => {
      const result = await terminalTool.execute({
        command: "echo 'first' && echo 'second'",
      });

      expect(result).toContain("first");
      expect(result).toContain("second");
    });

    test("handles command chaining with ;", async () => {
      const result = await terminalTool.execute({
        command: "echo 'first'; echo 'second'",
      });

      expect(result).toContain("first");
      expect(result).toContain("second");
    });

    test("handles variable substitution", async () => {
      const result = await terminalTool.execute({
        command: "MESSAGE=hello && echo $MESSAGE",
      });

      expect(result).toContain("hello");
    });

    test("handles quotes in command", async () => {
      const result = await terminalTool.execute({
        command: `echo "quoted string"`,
      });

      expect(result).toContain("quoted string");
    });

    test("handles single quotes", async () => {
      const result = await terminalTool.execute({
        command: `echo 'single quoted'`,
      });

      expect(result).toContain("single quoted");
    });

    test("handles backticks (command substitution)", async () => {
      const result = await terminalTool.execute({
        command: "echo `echo nested`",
      });

      expect(result).toContain("nested");
    });
  });

  describe("File Operations", () => {
    test("can read files", async () => {
      // Create temp file
      const tmpFile = `/tmp/woop-terminal-test-${Date.now()}.txt`;
      await Bun.write(tmpFile, "test content");

      const result = await terminalTool.execute({
        command: `cat ${tmpFile}`,
      });

      expect(result).toBe("test content");
    });

    test("can write files", async () => {
      const tmpFile = `/tmp/woop-terminal-test-${Date.now()}.txt`;

      await terminalTool.execute({
        command: `echo 'written content' > ${tmpFile}`,
      });

      const actual = await Bun.file(tmpFile).text();
      expect(actual).toContain("written content");
    });

    test("can list files", async () => {
      const result = await terminalTool.execute({
        command: "ls /tmp | head -5",
      });

      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("Unicode & Special Characters", () => {
    test("handles unicode output", async () => {
      const result = await terminalTool.execute({
        command: "echo '世界 🚀'",
      });

      expect(result).toContain("世界");
      expect(result).toContain("🚀");
    });

    test("handles special characters in output", async () => {
      const result = await terminalTool.execute({
        command: "echo '$#@!%'",
      });

      expect(result).toContain("$#@!%");
    });

    test("handles newlines in output", async () => {
      const result = await terminalTool.execute({
        command: "printf 'line1\\nline2\\nline3'",
      });

      expect(result).toBe("line1\nline2\nline3");
    });
  });

  describe("Large Output", () => {
    test("handles large stdout (1KB)", async () => {
      const result = await terminalTool.execute({
        command: "head -c 1024 /dev/zero | base64",
      });

      expect(result.length).toBeGreaterThan(1000);
    });

    test("handles large stdout (100KB)", async () => {
      const result = await terminalTool.execute({
        command: "head -c 102400 /dev/zero | base64",
      });

      expect(result.length).toBeGreaterThan(100000);
    });

    test("handles many lines of output", async () => {
      const result = await terminalTool.execute({
        command: "seq 1 1000",
      });

      const lines = result.trim().split("\n");
      expect(lines.length).toBe(1000);
      expect(lines[0]).toBe("1");
      expect(lines[999]).toBe("1000");
    });
  });

  describe("Exit Codes", () => {
    test("handles successful exit (0)", async () => {
      const result = await terminalTool.execute({
        command: "exit 0",
      });

      expect(result).toBe("");
    });

    test("handles non-zero exit code", async () => {
      const result = await terminalTool.execute({
        command: "exit 1",
      });

      // Tool doesn't throw, but might return stderr
      // Just verify it completes
      expect(typeof result).toBe("string");
    });
  });

  describe("Performance", () => {
    test("completes quickly for simple command", async () => {
      const start = Date.now();

      await terminalTool.execute({
        command: "echo fast",
      });

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000); // <1s
    });

    test("handles slightly slower command", async () => {
      const start = Date.now();

      await terminalTool.execute({
        command: "sleep 0.1 && echo done",
      });

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000); // <2s
    });
  });

  describe("Edge Cases", () => {
    test("handles command with only whitespace in output", async () => {
      const result = await terminalTool.execute({
        command: "echo '   '",
      });

      expect(result).toBe("   \n");
    });

    test("handles command with tabs", async () => {
      const result = await terminalTool.execute({
        command: "printf '\\t\\t'",
      });

      expect(result).toBe("\t\t");
    });

    test("handles command with mixed stdout/stderr", async () => {
      const result = await terminalTool.execute({
        command: "echo 'stdout' && echo 'stderr' >&2",
      });

      // If stderr exists, it's returned
      // Otherwise stdout is returned
      expect(result).toMatch(/stdout|stderr/);
    });
  });

  describe("Real-World Commands", () => {
    test("works with node/bun version check", async () => {
      const result = await terminalTool.execute({
        command: "bun --version",
      });

      expect(result).toMatch(/\d+\.\d+\.\d+/); // Version format
    });

    test("works with git commands", async () => {
      const result = await terminalTool.execute({
        command: "git --version",
      });

      expect(result).toContain("git version");
    });

    test("works with pwd", async () => {
      const result = await terminalTool.execute({
        command: "pwd",
      });

      expect(result).toMatch(/\//); // Contains path separator
    });

    test("works with date", async () => {
      const result = await terminalTool.execute({
        command: "date",
      });

      expect(result.length).toBeGreaterThan(10);
    });
  });
});
