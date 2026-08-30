import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 *
 * Every tool here runs through `requestCommandApproval`, which reads the
 * configured mode through `getApprovalMode()` — so config reads go to a temp
 * directory rather than the developer's real `~/.config/woopcode`. Stubbing
 * `setPendingCommand` is not enough on its own: it answers the prompt, it does
 * not stop the mode being read from disk. `approval.integration.test.ts` is the
 * sibling this follows, including the reason the redirect is restored in
 * `afterAll` and never in `afterEach`.
 */
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const temporaryConfigHome = mkdtempSync(join(tmpdir(), "woopcode-timeout-"));
process.env.XDG_CONFIG_HOME = temporaryConfigHome;

// Imported after the redirect is in place: a static import is bound at load,
// which for anything reading config at module scope would be before the line
// above ever ran.
const { terminalTool } = await import("../../../tools/terminal");
const { runTestsTool } = await import("../../../tools/runTests");
const { replTool } = await import("../../../tools/repl");
const { closeReplSessions } = await import("../../../tools/replSession");
const { clearDeadline } = await import("../../../runtime/deadline");
const { store } = await import("../../../tui/src/store/ui-store");
// Deferred like the rest, so the redirect above is in place before anything it
// pulls in reaches config at module scope.
const { budgetWith } = await import("../shared/deadline");

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

    // Restored once, at the end. Doing it per test would drop the redirect
    // after the first one on any machine that does not set the variable — the
    // normal case — and point every later config read at the real directory.
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    rmSync(temporaryConfigHome, { recursive: true, force: true });
  });

  describe("run_terminal", () => {
    test("cuts a requested timeout down to what is left of the budget", async () => {
      budgetWith(1.5);
      const start = Date.now();

      const result = await terminalTool.execute({ command: "sleep 30", timeout: 60 });

      expect(result).toContain("Command timed out after 1 seconds");
      // The message says what the clamp granted; this says the process really
      // stopped there. `sleep 30` rather than a shorter one so the two outcomes
      // are 1s and 30s apart: a runner would have to stall fourteen seconds to
      // make this flake, where the gap between 1s and 5s is inside the noise a
      // loaded CI box produces. That noise is what broke the cancellation test
      // on macOS.
      expect(Date.now() - start).toBeLessThan(15_000);
    });

    test("says the clock ran out, not that the timeout was too small", async () => {
      budgetWith(1.5);

      const result = await terminalTool.execute({ command: "sleep 30", timeout: 60 });

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

      const result = await runTestsTool.execute({ command: "sleep 30", timeout: 60 });

      expect(result).toContain("Command timed out after 1 seconds");
      expect(result).toContain("wall-clock budget");
      expect(result).not.toContain("verify a server starts");
      // 1s against 30s, for the reason the run_terminal case gives.
      expect(Date.now() - start).toBeLessThan(15_000);
    });

    test("an unbudgeted session keeps the standing advice", async () => {
      const result = await runTestsTool.execute({ command: "sleep 2", timeout: 0.05 });

      expect(result).toContain("Command timed out after 0.05 seconds");
      expect(result).toContain("verify a server starts");
      expect(result).not.toContain("wall-clock budget");
    });

    test("leaves a timeout that already fits inside the budget alone", async () => {
      budgetWith(600);

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

    test("leaves a timeout that already fits inside the budget alone", async () => {
      budgetWith(600);

      const result = await replTool.execute({
        language: "python",
        code: "import time; time.sleep(30)",
        timeout: 1,
      });

      // A budget far larger than the request clamps nothing, and the answer is
      // the bare error this path has always returned — no standing advice to
      // swap the wall notice in for.
      expect(result).toContain("timed out after 1 seconds");
      expect(result).not.toContain("wall-clock budget");
    });
  });
});
