import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test";
import {
  processOutputTool,
  processStartTool,
  processStopTool,
  trackedProcessIds,
  stopAllProcesses,
} from "../../../tools/process";
import { store } from "../../../tui/src/store/ui-store";

/**
 * INTEGRATION TESTS for the background process tools.
 *
 * Real processes. A mock would defeat the purpose: what is being tested is that
 * something keeps running after the call returns, which is a property of the
 * process table and not of the code around it.
 *
 * Every test stops what it started. A leaked process holds its pipes open and
 * the test runner waits on them at exit.
 */

/** Waits for a predicate, polling. Never longer than the bound. */
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(25);
  }
  return predicate();
}

/** The id out of process_start's confirmation. */
function idOf(result: string): string {
  const match = result.match(/Started (bg\d+):/);
  if (!match) throw new Error(`no id in: ${result}`);
  return match[1]!;
}

describe("process Tools - Integration Tests", () => {
  const originalSetPendingCommand = store.setPendingCommand;

  beforeEach(() => {
    store.setPendingCommand = async () => true;
  });

  afterEach(() => {
    store.setPendingCommand = originalSetPendingCommand;
    stopAllProcesses();
  });

  afterAll(() => {
    stopAllProcesses();
  });

  describe("Argument validation", () => {
    test("process_start rejects a call with no arguments", async () => {
      expect(processStartTool.execute({})).rejects.toThrow(/command is required/);
    });

    test("process_output rejects a call with no arguments", async () => {
      expect(processOutputTool.execute({})).rejects.toThrow(/id is required/);
    });

    test("process_stop rejects a call with no arguments", async () => {
      expect(processStopTool.execute({})).rejects.toThrow(/id is required/);
    });

    test("an unknown id says so and lists what exists", async () => {
      expect(processOutputTool.execute({ id: "bg99" })).rejects.toThrow(
        /No background process bg99.*None have been started/s,
      );
    });

    test("a cwd outside the workspace is refused", async () => {
      expect(
        processStartTool.execute({ command: "echo hi", cwd: "/etc" }),
      ).rejects.toThrow(/escapes the workspace/);
    });
  });

  describe("Starting and reading", () => {
    test("returns immediately with an id while the process runs on", async () => {
      const started = await processStartTool.execute({ command: "sleep 5" });
      const id = idOf(started);

      expect(trackedProcessIds()).toContain(id);
      expect(await processOutputTool.execute({ id })).toContain("running for");
    });

    test("collects output produced after the call returned", async () => {
      const id = idOf(await processStartTool.execute({ command: "sleep 0.3; echo late" }));

      // The point of the tool: nothing was waited for, so the output cannot
      // have existed when process_start returned.
      expect(await processOutputTool.execute({ id })).toContain("No new output");

      await Bun.sleep(1200);
      expect(await processOutputTool.execute({ id })).toContain("late");
    });

    test("output already returned is not repeated", async () => {
      const id = idOf(await processStartTool.execute({ command: "echo once" }));
      await until(() => trackedProcessIds().includes(id));
      await Bun.sleep(500);

      expect(await processOutputTool.execute({ id })).toContain("once");
      expect(await processOutputTool.execute({ id })).toContain("No new output");
    });

    test("captures stderr as well as stdout", async () => {
      const id = idOf(
        await processStartTool.execute({ command: "echo to-err 1>&2" }),
      );
      await Bun.sleep(500);
      expect(await processOutputTool.execute({ id })).toContain("to-err");
    });

    test("reports a process that has exited", async () => {
      const id = idOf(await processStartTool.execute({ command: "exit 3" }));
      await Bun.sleep(500);
      expect(await processOutputTool.execute({ id })).toContain("exited with code 3");
    });
  });

  describe("Stopping", () => {
    test("stops a running process and forgets the id", async () => {
      const id = idOf(await processStartTool.execute({ command: "sleep 30" }));

      const stopped = await processStopTool.execute({ id });
      expect(stopped).toContain(`Stopped ${id}`);
      expect(trackedProcessIds()).not.toContain(id);
    });

    test("returns output that was never read", async () => {
      const id = idOf(await processStartTool.execute({ command: "echo parting; sleep 30" }));
      await Bun.sleep(500);

      expect(await processStopTool.execute({ id })).toContain("parting");
    });

    test("stopping twice reports the id is unknown rather than hanging", async () => {
      const id = idOf(await processStartTool.execute({ command: "sleep 30" }));
      await processStopTool.execute({ id });

      expect(processStopTool.execute({ id })).rejects.toThrow(/No background process/);
    });

    test("stops the whole tree, not just the shell", async () => {
      // The leak this tool exists to prevent. Killing only the spawned shell
      // leaves its children holding ports and files — measured before the fix:
      // two processes before the stop, one still alive after it.
      //
      // `; true` keeps bash from exec-ing into python, so there is a real
      // parent and a real child rather than one process wearing both hats.
      const marker = `wooptest${crypto.randomUUID().replace(/-/g, "")}`;
      const alive = () =>
        new TextDecoder()
          .decode(Bun.spawnSync({ cmd: ["pgrep", "-f", marker] }).stdout)
          .trim()
          .split("\n")
          .filter(Boolean);

      const id = idOf(
        await processStartTool.execute({
          command: `python3 -c "import time; time.sleep(120)" ${marker} ; true`,
        }),
      );

      expect(await until(() => alive().length > 0)).toBe(true);

      await processStopTool.execute({ id });

      const gone = await until(() => alive().length === 0);
      // Kill anything the fix failed to, so a failure here does not leak a
      // sleeping process into the rest of the run.
      for (const pid of alive()) {
        try {
          process.kill(Number(pid), 9);
        } catch {
          // Already gone between the listing and the signal.
        }
      }

      expect(gone).toBe(true);
    });

    test("an id is never reused after its process is stopped", async () => {
      // A model holds the whole transcript, so it always might quote an old id.
      // Reusing `bg1` would make that a silent mix-up — reading or killing a
      // different process and getting a plausible answer — instead of an error.
      const first = idOf(await processStartTool.execute({ command: "sleep 30" }));
      await processStopTool.execute({ id: first });

      const second = idOf(await processStartTool.execute({ command: "sleep 30" }));
      expect(second).not.toBe(first);
      expect(processOutputTool.execute({ id: first })).rejects.toThrow(
        /No background process/,
      );
    });

    test("stopAllProcesses ends everything", async () => {
      await processStartTool.execute({ command: "sleep 30" });
      await processStartTool.execute({ command: "sleep 30" });
      expect(trackedProcessIds().length).toBe(2);

      stopAllProcesses();
      expect(trackedProcessIds()).toEqual([]);
    });
  });

  describe("Approval", () => {
    test("a rejected command starts nothing", async () => {
      store.setPendingCommand = async () => false;

      const result = await processStartTool.execute({ command: "sleep 30" });

      expect(result).toContain("rejected by user");
      expect(trackedProcessIds()).toEqual([]);
    });
  });
});
