import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test";
import { replTool } from "../../../tools/repl";
import { closeReplSessions, openReplLanguages } from "../../../tools/replSession";
import { store } from "../../../tui/src/store/ui-store";

/**
 * INTEGRATION TESTS for the repl tool.
 *
 * Real interpreters, spawned for real. The whole point of the tool is that a
 * process outlives the call, and nothing about that survives being mocked —
 * a fake that returned canned output would pass while the sessions leaked.
 *
 * Only the approval prompt is faked, because there is no human here.
 */

describe("repl Tool - Integration Tests", () => {
  const originalSetPendingCommand = store.setPendingCommand;

  beforeEach(() => {
    store.setPendingCommand = async () => true;
  });

  afterEach(() => {
    store.setPendingCommand = originalSetPendingCommand;
    // Each test starts from no interpreter. Without this a session from an
    // earlier test answers the next one with variables it never set — which is
    // exactly the bug the per-turn scope exists to prevent, and a test suite
    // that leaked it would be unable to detect it.
    closeReplSessions();
  });

  afterAll(() => {
    closeReplSessions();
  });

  describe("Argument validation", () => {
    test("rejects a call with no arguments", async () => {
      expect(replTool.execute({})).rejects.toThrow(/language must be one of/);
    });

    test("rejects an unknown language", async () => {
      expect(replTool.execute({ language: "ruby", code: "1" })).rejects.toThrow(
        /language must be one of/,
      );
    });

    test("rejects empty code", async () => {
      expect(replTool.execute({ language: "python", code: "   " })).rejects.toThrow(
        /code is required/,
      );
    });

    test("rejects a non-positive timeout", async () => {
      expect(
        replTool.execute({ language: "python", code: "1", timeout: 0 }),
      ).rejects.toThrow(/timeout must be a positive number/);
    });

    test("validates before spawning anything", async () => {
      await replTool.execute({ language: "nope" }).catch(() => {});
      expect(openReplLanguages()).toEqual([]);
    });
  });

  describe("Python sessions", () => {
    test("evaluates and prints a trailing expression", async () => {
      const result = await replTool.execute({ language: "python", code: "2 + 3" });
      expect(result).toContain("5");
    });

    test("state survives between calls", async () => {
      await replTool.execute({ language: "python", code: "values = [1, 2, 3, 4]" });
      const result = await replTool.execute({ language: "python", code: "sum(values)" });
      expect(result).toContain("10");
    });

    test("reports an assignment that printed nothing as a success", async () => {
      const result = await replTool.execute({ language: "python", code: "x = 1" });
      expect(result).toMatch(/produced no output/);
    });

    test("captures stdout in order with the expression value", async () => {
      const result = await replTool.execute({
        language: "python",
        code: "print('first')\n'second'",
      });
      expect(result.indexOf("first")).toBeLessThan(result.indexOf("second"));
    });

    test("returns a traceback without killing the session", async () => {
      const failed = await replTool.execute({ language: "python", code: "1 / 0" });
      expect(failed).toContain("ZeroDivisionError");

      const after = await replTool.execute({ language: "python", code: "'alive'" });
      expect(after).toContain("alive");
    });

    test("handles unicode and emoji", async () => {
      const result = await replTool.execute({
        language: "python",
        code: "'héllo 🌍 世界'",
      });
      expect(result).toContain("🌍");
      expect(result).toContain("世界");
    });

    test("restart discards the previous state", async () => {
      await replTool.execute({ language: "python", code: "kept = 99" });
      const result = await replTool.execute({
        language: "python",
        code: "'kept' in dir()",
        restart: true,
      });
      expect(result).toContain("False");
    });
  });

  describe("Node sessions", () => {
    test("evaluates an expression", async () => {
      const result = await replTool.execute({ language: "node", code: "6 * 7" });
      expect(result).toContain("42");
    });

    test("a top-level var survives between calls", async () => {
      await replTool.execute({ language: "node", code: "var total = 8" });
      const result = await replTool.execute({ language: "node", code: "total + 1" });
      expect(result).toContain("9");
    });

    test("reports a thrown error without killing the session", async () => {
      const failed = await replTool.execute({
        language: "node",
        code: "throw new Error('boom')",
      });
      expect(failed).toContain("boom");

      const after = await replTool.execute({ language: "node", code: "'alive'" });
      expect(after).toContain("alive");
    });
  });

  describe("Session lifetime", () => {
    test("python and node are separate sessions", async () => {
      await replTool.execute({ language: "python", code: "shared = 'py'" });
      await replTool.execute({ language: "node", code: "var shared = 'node'" });

      expect(await replTool.execute({ language: "python", code: "shared" })).toContain("py");
      expect(await replTool.execute({ language: "node", code: "shared" })).toContain("node");
      expect(openReplLanguages().sort()).toEqual(["node", "python"]);
    });

    test("closeReplSessions ends every session", async () => {
      await replTool.execute({ language: "python", code: "1" });
      await replTool.execute({ language: "node", code: "1" });
      expect(openReplLanguages().length).toBe(2);

      closeReplSessions();
      expect(openReplLanguages()).toEqual([]);
    });

    test("state is gone after the sessions are closed", async () => {
      await replTool.execute({ language: "python", code: "carried = 5" });
      closeReplSessions();

      const result = await replTool.execute({
        language: "python",
        code: "'carried' in dir()",
      });
      expect(result).toContain("False");
    });
  });

  describe("Timeouts", () => {
    test("a runaway evaluation ends and discards the session", async () => {
      const result = await replTool.execute({
        language: "python",
        code: "import time; time.sleep(30)",
        timeout: 1,
      });

      expect(result).toContain("timed out after 1 seconds");
      expect(openReplLanguages()).toEqual([]);
    });

    test("the next call after a timeout starts a working session", async () => {
      await replTool.execute({
        language: "python",
        code: "import time; time.sleep(30)",
        timeout: 1,
      });

      const result = await replTool.execute({ language: "python", code: "'recovered'" });
      expect(result).toContain("recovered");
    });
  });

  describe("Approval", () => {
    test("a rejected call runs nothing and starts no session", async () => {
      store.setPendingCommand = async () => false;

      const result = await replTool.execute({
        language: "python",
        code: "import subprocess; subprocess.run(['true'])",
      });

      expect(result).toContain("rejected by user");
      expect(openReplLanguages()).toEqual([]);
    });
  });
});
