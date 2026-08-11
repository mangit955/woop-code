import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  currentExecutor,
  localExecutor,
  resetExecutor,
  setExecutor,
  type Executor,
  type ProcessHandle,
} from "../../../runtime/sandbox";
import { terminalTool } from "../../../tools/terminal";
import { runTestsTool } from "../../../tools/runTests";
import {
  processStartTool,
  processOutputTool,
  processStopTool,
  stopAllProcesses,
} from "../../../tools/process";
import { store } from "../../../tui/src/store/ui-store";

/**
 * That the executor seam is real.
 *
 * The point of Phase 1 is that a command tool no longer decides where its
 * command runs — it asks whatever executor is installed. That is only true if
 * setting a different executor actually diverts the command, so this installs
 * one that runs nothing and proves the host never sees the command.
 *
 * No `mock.module` anywhere: `setExecutor` is a real seam, so faking one does
 * not require rewriting a module for the whole test run. That matters here more
 * than usual — a module mock cannot be undone once registered, and this file
 * fakes the thing every other tool test depends on.
 */

interface Recorded {
  command: string;
  timeoutSeconds?: number;
  cwd?: string;
}

class FakeHandle implements ProcessHandle {
  #sink: ((chunk: string) => void) | null = null;
  #resolve!: (code: number | null) => void;

  exitCode: number | null = null;
  exited: Promise<number | null> = new Promise((resolve) => {
    this.#resolve = resolve;
  });
  terminated = false;
  unrefd = false;
  keptAlive = 0;
  syncedBack = 0;
  /** What the pull has to say, for the test that it reaches the model. */
  syncNote = "";

  onOutput(sink: (chunk: string) => void): void {
    this.#sink = sink;
  }

  keepAlive(): void {
    this.keptAlive++;
  }

  async syncBack(): Promise<string> {
    this.syncedBack++;
    return this.syncNote;
  }

  /** Drives the tool from the test's side, as a real process would. */
  emit(chunk: string): void {
    this.#sink?.(chunk);
  }

  finish(code: number): void {
    this.exitCode = code;
    this.#resolve(code);
  }

  terminate(): void {
    this.terminated = true;
    this.finish(143);
  }

  unref(): void {
    this.unrefd = true;
  }
}

function fakeExecutor() {
  const ran: Recorded[] = [];
  const started: Recorded[] = [];
  const handles: FakeHandle[] = [];

  const executor: Executor = {
    kind: "sandbox",
    async run(command, timeoutSeconds, _signal, cwd) {
      ran.push({ command, timeoutSeconds, cwd });
      return { stdout: `ran elsewhere: ${command}`, stderr: "", exitCode: 0 };
    },
    async start(command, cwd) {
      started.push({ command, cwd });
      const handle = new FakeHandle();
      handles.push(handle);
      return handle;
    },
    async urlForPort(port) {
      return `https://${port}-fake.example`;
    },
  };

  return { executor, ran, started, handles };
}

describe("executor seam", () => {
  const originalSetPendingCommand = store.setPendingCommand;

  /**
   * The host-side side effect the diversion test checks for the absence of.
   *
   * Named with a UUID and removed on both sides of every test. It has to be:
   * when the seam was deliberately broken to prove this suite can fail, the
   * command really did run and really did create this file — and a stale one
   * left behind then makes the *fixed* code look broken on the next run. A test
   * that asserts a file does not exist has to own that file completely.
   */
  const probe = `${process.cwd()}/.executor-seam-probe-${crypto.randomUUID()}`;

  async function removeProbe() {
    await Bun.file(probe)
      .unlink()
      .catch(() => {});
  }

  beforeEach(async () => {
    store.setPendingCommand = async () => true;
    await removeProbe();
  });

  afterEach(async () => {
    store.setPendingCommand = originalSetPendingCommand;
    stopAllProcesses();
    await removeProbe();
    // Module state outlives a test file, so a fake left installed here would
    // point the rest of the run at it.
    resetExecutor();
  });

  test("the default executor is local", () => {
    expect(currentExecutor()).toBe(localExecutor);
    expect(currentExecutor().kind).toBe("local");
  });

  test("run_terminal routes to the installed executor and not to the host", async () => {
    const { executor, ran } = fakeExecutor();
    setExecutor(executor);

    // A command with an unmistakable side effect on the host, so "it was
    // diverted" is checked by the absence of that effect and not only by the
    // recorded call.
    const result = await terminalTool.execute({ command: `touch ${probe}` });

    expect(ran).toHaveLength(1);
    expect(ran[0]!.command).toBe(`touch ${probe}`);
    expect(result).toContain("ran elsewhere");
    expect(await Bun.file(probe).exists()).toBe(false);
  });

  test("run_terminal passes its timeout through", async () => {
    const { executor, ran } = fakeExecutor();
    setExecutor(executor);

    await terminalTool.execute({ command: "echo hi", timeout: 12 });

    expect(ran[0]!.timeoutSeconds).toBe(12);
  });

  test("run_tests routes to the installed executor", async () => {
    const { executor, ran } = fakeExecutor();
    setExecutor(executor);

    const result = await runTestsTool.execute({ command: "bun test" });

    expect(ran).toHaveLength(1);
    expect(ran[0]!.command).toBe("bun test");
    expect(result).toContain("ran elsewhere");
  });

  test("process_start routes to the installed executor, and reads and stops go to its handle", async () => {
    const { executor, started, handles } = fakeExecutor();
    setExecutor(executor);

    const startResult = await processStartTool.execute({ command: "sleep 30" });
    const id = startResult.match(/Started (bg\d+):/)?.[1];

    expect(started).toHaveLength(1);
    expect(started[0]!.command).toBe("sleep 30");
    expect(id).toBeTruthy();

    // Output reaches the tool through the handle's sink rather than a pipe.
    handles[0]!.emit("from the fake\n");
    expect(await processOutputTool.execute({ id })).toContain("from the fake");

    await processStopTool.execute({ id });
    expect(handles[0]!.terminated).toBe(true);
  });

  describe("a background process running somewhere else", () => {
    async function startOne(args: Record<string, unknown> = {}) {
      const fake = fakeExecutor();
      setExecutor(fake.executor);
      const result = await processStartTool.execute({ command: "sleep 30", ...args });
      const id = result.match(/Started (bg\d+):/)?.[1]!;
      return { ...fake, id, result };
    }

    test("reading and stopping renew the lease, so it is not reaped mid-session", async () => {
      // A sandbox's lifetime is refreshed per command. A development server the
      // agent starts and then watches issues no commands at all, so without
      // this it is reaped underneath the session with nothing to say so.
      const { id, handles } = await startOne();
      expect(handles[0]!.keptAlive).toBe(0);

      await processOutputTool.execute({ id });
      expect(handles[0]!.keptAlive).toBe(1);

      await processStopTool.execute({ id });
      expect(handles[0]!.keptAlive).toBe(2);
    });

    test("what it wrote is pulled back once, at the stop", async () => {
      // Not per read: `process_output` is called in a polling loop, and a
      // remote listing and a diff behind each one would make watching a build
      // cost more than running it.
      const { id, handles } = await startOne();

      await processOutputTool.execute({ id });
      await processOutputTool.execute({ id });
      expect(handles[0]!.syncedBack).toBe(0);

      await processStopTool.execute({ id });
      expect(handles[0]!.syncedBack).toBe(1);
    });

    test("what the pull has to say reaches the model", async () => {
      const { id, handles } = await startOne();
      handles[0]!.syncNote = "\n\n[sandbox sync]\nsrc/a.ts was changed locally.";

      const stopped = await processStopTool.execute({ id });

      // A conflict the model cannot see is a conflict it cannot reconcile.
      expect(stopped).toContain("src/a.ts was changed locally");
    });

    test("a port is answered with the executor's URL, not with localhost", async () => {
      // The whole point of asking the executor: sandboxed, the server is not on
      // this machine, and a model told to try localhost gets a connection
      // refused and concludes its server failed to start.
      const { result } = await startOne({ command: "bun run site", port: 3000 });

      expect(result).toContain("https://3000-fake.example");
      expect(result).not.toContain("localhost");
    });

    test("an unusable port is refused before anything is started", async () => {
      const { executor, started } = fakeExecutor();
      setExecutor(executor);

      await expect(
        processStartTool.execute({ command: "bun run site", port: 70000 }),
      ).rejects.toThrow(/between 1 and 65535/);
      expect(started).toEqual([]);
    });

    test("locally the URL is simply this machine", async () => {
      expect(await localExecutor.urlForPort(3000)).toBe("http://localhost:3000");
    });
  });

  test("a rejected command never reaches the executor at all", async () => {
    const { executor, ran, started } = fakeExecutor();
    setExecutor(executor);
    store.setPendingCommand = async () => false;

    await terminalTool.execute({ command: "rm -rf /" });
    await processStartTool.execute({ command: "rm -rf /" });

    // Approval is upstream of the executor, and stays upstream: a sandbox is
    // not a reason to run something the user declined.
    expect(ran).toEqual([]);
    expect(started).toEqual([]);
  });

  test("the local executor runs where it is told", async () => {
    // `cwd` is new on this path — `runCommand` never took one before the
    // interface needed it. An option that is only ever passed and never
    // asserted is an option nobody has checked arrives.
    const result = await localExecutor.run("pwd", 10, undefined, "/tmp");

    expect(result.exitCode).toBe(0);
    // macOS resolves /tmp to /private/tmp, so match the tail rather than the
    // whole path.
    expect(result.stdout.trim()).toMatch(/\/tmp$/);
  });

  test("the local executor starts background work where it is told", async () => {
    const handle = await localExecutor.start("pwd", "/tmp");
    let output = "";
    handle.onOutput((chunk) => {
      output += chunk;
    });

    await handle.exited;
    // The pump is asynchronous, so the last chunk can land after `exited`.
    await Bun.sleep(50);

    expect(output.trim()).toMatch(/\/tmp$/);
    handle.terminate();
  });

  test("resetExecutor puts the local one back", () => {
    const { executor } = fakeExecutor();
    setExecutor(executor);
    expect(currentExecutor().kind).toBe("sandbox");

    resetExecutor();
    expect(currentExecutor()).toBe(localExecutor);
  });
});
