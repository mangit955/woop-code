import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { terminalTool } from "../../../tools/terminal";
import { store } from "../../../tui/src/store/ui-store";

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
  const originalSetPendingCommand = store.setPendingCommand;

  beforeEach(() => {
    store.setPendingCommand = async () => true;
  });

  afterEach(() => {
    store.setPendingCommand = originalSetPendingCommand;
  });

  const stdoutOf = (result: string) =>
    result.split("STDOUT:\n")[1]?.split("\n\nSTDERR:")[0] ?? "";

  describe("Basic Execution", () => {
    test("executes simple command", async () => {
      const result = await terminalTool.execute({
        command: "echo hello",
      });

      expect(result).toContain("Exit code: 0");
      expect(stdoutOf(result)).toBe("hello\n");
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

      expect(result).toBe("Exit code: 0\n\nSTDOUT:\n\n\nSTDERR:\n");
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
      const tmpFile = `/tmp/woop-terminal-test-${crypto.randomUUID()}.txt`;
      await Bun.write(tmpFile, "test content");

      const result = await terminalTool.execute({
        command: `cat ${tmpFile}`,
      });

      expect(stdoutOf(result)).toBe("test content");
    });

    test("can write files", async () => {
      const tmpFile = `/tmp/woop-terminal-test-${crypto.randomUUID()}.txt`;

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

      expect(stdoutOf(result)).toBe("line1\nline2\nline3");
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

      const lines = stdoutOf(result).trim().split("\n");
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

      expect(result).toContain("Exit code: 0");
    });

    test("handles non-zero exit code", async () => {
      const result = await terminalTool.execute({
        command: "exit 1",
      });

      expect(result).toContain("Exit code: 1");
    });
  });

  describe("Cancellation and timeouts", () => {
    test("returns promptly when a command times out", async () => {
      const start = Date.now();
      const result = await terminalTool.execute({ command: "sleep 2", timeout: 0.05 });

      expect(result).toContain("Command timed out after 0.05 seconds");
      expect(Date.now() - start).toBeLessThan(1000);
    });

    test("returns promptly even when the command ignores SIGTERM", async () => {
      // The failure this guards against: a signal that does not stop the command
      // used to leave the caller waiting for it to finish on its own, so the
      // timeout was not a timeout. Trapping TERM reproduces that on any platform
      // — SIGKILL and the bounded wait are what have to save it.
      const start = Date.now();
      const result = await terminalTool.execute({
        command: "trap '' TERM; sleep 5",
        timeout: 0.05,
      });

      expect(result).toContain("Command timed out after 0.05 seconds");
      expect(Date.now() - start).toBeLessThan(2000);
    });

    test("stops a running command when its agent signal is aborted", async () => {
      const controller = new AbortController();
      const start = Date.now();
      const command = terminalTool.execute({ command: "sleep 5" }, controller.signal);
      setTimeout(() => controller.abort(), 25);

      await expect(command).resolves.toBe("Command cancelled before completion.");
      expect(Date.now() - start).toBeLessThan(1000);
    });

    test("rejects unquoted background operators without rejecting && or redirection", async () => {
      await expect(terminalTool.execute({ command: "echo ready &" })).resolves.toContain("Background processes");
      await expect(terminalTool.execute({ command: "echo ready && echo done" })).resolves.toContain("done");
      await expect(terminalTool.execute({ command: "echo warning >&2" })).resolves.toContain("warning");
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

      expect(stdoutOf(result)).toBe("   \n");
    });

    test("handles command with tabs", async () => {
      const result = await terminalTool.execute({
        command: "printf '\\t\\t'",
      });

      expect(stdoutOf(result)).toBe("\t\t");
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
