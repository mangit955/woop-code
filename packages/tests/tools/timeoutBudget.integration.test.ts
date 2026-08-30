import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test";
import { terminalTool } from "../../../tools/terminal";
import { runTestsTool } from "../../../tools/runTests";
import { replTool } from "../../../tools/repl";
import { closeReplSessions } from "../../../tools/replSession";
import { WALL_RESERVE_SEC, clearDeadline, setDeadline } from "../../../runtime/deadline";
import { store } from "../../../tui/src/store/ui-store";

/**
 * INTEGRATION TESTS for tool timeouts under the wall-clock budget.
 *
 * Real commands and a real interpreter, killed by real timers — the thing under
 * test is how long a command is allowed to run, and a fake executor would be
 * asserting on the number rather than on the kill. Only the clock the budget is
 * measured against is injected, and only the approval prompt is faked.
 *
 * The clock is frozen rather than advanced: what a command is granted is decided
 * once, when it starts, so a still clock reproduces every case and keeps the
 * elapsed time these tests spend to about a second each.
 */

/** A budget with `seconds` left on it, on a clock that does not move. */
function budgetWith(seconds: number) {
  setDeadline(WALL_RESERVE_SEC + seconds, { now: () => 0, startedAt: 0 });
}

describe("tool timeouts under a wall-clock budget", () => {
  const originalSetPendingCommand = store.setPendingCommand;

  beforeEach(() => {
    store.setPendingCommand = async () => true;
  });

  afterEach(() => {
    store.setPendingCommand = originalSetPendingCommand;
    // Module state outlives a file. A deadline left armed here would shorten
    // every command in every test that runs after it, and the fake clock would
    // leave them measuring against a number that never moves.
    clearDeadline();
    closeReplSessions();
  });

  afterAll(() => {
    closeReplSessions();
  });

  describe("run_terminal", () => {
    test("cuts a requested timeout down to what is left of the budget", async () => {
      budgetWith(1.5);
      const start = Date.now();

      const result = await terminalTool.execute({ command: "sleep 5", timeout: 60 });

      expect(result).toContain("Command timed out after 1 seconds");
      expect(Date.now() - start).toBeLessThan(4000);
    });

    test("says the clock ran out, not that the timeout was too small", async () => {
      budgetWith(1.5);

      const result = await terminalTool.execute({ command: "sleep 5", timeout: 60 });

      // The standing advice is to retry with a larger timeout, which would burn
      // the last seconds of the budget on a command that cannot finish.
      expect(result).not.toContain("larger timeout");
      expect(result).toContain("wall-clock budget");
      expect(result).toContain("60s");
    });

    test("leaves a timeout that already fits inside the budget alone", async () => {
      budgetWith(600);

      const result = await terminalTool.execute({ command: "sleep 2", timeout: 0.05 });

      expect(result).toContain("Command timed out after 0.05 seconds");
      expect(result).toContain("larger timeout");
      expect(result).not.toContain("wall-clock budget");
    });

    test("an unbudgeted session is answered exactly as it is today", async () => {
      const result = await terminalTool.execute({ command: "sleep 2", timeout: 0.05 });

      expect(result).toBe(
        "Error: Command timed out after 0.05 seconds\n\n" +
          "If this command was never going to exit on its own — a server, a watcher — " +
          "start it with process_start instead and read it with process_output. If it " +
          "was simply slow, run it again with a larger timeout.",
      );
    });
  });

  describe("run_tests", () => {
    test("cuts a requested timeout down to what is left of the budget", async () => {
      budgetWith(1.5);
      const start = Date.now();

      const result = await runTestsTool.execute({ command: "sleep 5", timeout: 60 });

      expect(result).toContain("Command timed out after 1 seconds");
      expect(result).toContain("wall-clock budget");
      expect(result).not.toContain("verify a server starts");
      expect(Date.now() - start).toBeLessThan(4000);
    });

    test("an unbudgeted session keeps the standing advice", async () => {
      const result = await runTestsTool.execute({ command: "sleep 2", timeout: 0.05 });

      expect(result).toContain("Command timed out after 0.05 seconds");
      expect(result).toContain("verify a server starts");
      expect(result).not.toContain("wall-clock budget");
    });
  });

  describe("repl", () => {
    test("clamps the default timeout, which the tool never passed before", async () => {
      // The default lives in `replSession`, and `repl` used to pass `undefined`
      // and let it apply — so an evaluation with no timeout argument had 120
      // seconds regardless of a budget with one second on it.
      budgetWith(1.5);
      const start = Date.now();

      const result = await replTool.execute({
        language: "python",
        code: "import time; time.sleep(30)",
      });

      expect(result).toContain("timed out after 1 seconds");
      expect(result).toContain("wall-clock budget");
      expect(Date.now() - start).toBeLessThan(15000);
    });

    test("an unbudgeted session runs for the timeout it asked for", async () => {
      const result = await replTool.execute({
        language: "python",
        code: "import time; time.sleep(30)",
        timeout: 1,
      });

      expect(result).toContain("timed out after 1 seconds");
      expect(result).not.toContain("wall-clock budget");
    });
  });
});
