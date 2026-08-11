import { test, expect, describe } from "bun:test";
import { createSandboxExecutor } from "../../../runtime/sandbox/sandboxExecutor";
import {
  SandboxSession,
  SandboxUnavailableError,
  type SandboxClient,
} from "../../../runtime/sandbox/session";
import { resolveSandboxSettings } from "../../../runtime/sandbox/settings";
import { localExecutor } from "../../../runtime/sandbox/localExecutor";

/**
 * The sandbox executor's error contract, against a fake E2B client.
 *
 * No network and no key, so all of this runs in CI — which matters, because the
 * rules here are the ones that fail silently. An executor that reports a failing
 * test suite as a broken sandbox still passes every integration test that only
 * ever runs commands which succeed.
 */

/** E2B's `CommandExitError`: a result that arrives by being thrown. */
class FakeCommandExitError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`exit status ${exitCode}`);
    this.name = "CommandExitError";
  }
}

interface FakeOptions {
  /** What `wait()` does. Resolves with a result, or throws. */
  wait?: () => Promise<unknown>;
  onKill?: (pid: number) => void;
  runThrows?: Error;
}

function fakeClient(options: FakeOptions = {}) {
  const commands: string[] = [];
  const killed: number[] = [];

  const client: SandboxClient = {
    sandboxId: "sbx-fake",
    commands: {
      async run(command: string) {
        commands.push(command);
        if (options.runThrows) throw options.runThrows;
        return {
          pid: 4242,
          wait:
            options.wait ??
            (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
        };
      },
      async kill(pid: number) {
        killed.push(pid);
        options.onKill?.(pid);
        return true;
      },
    },
    files: {
      async write() {
        return {};
      },
      async read() {
        return "";
      },
    },
    async setTimeout() {},
    async kill() {
      return true;
    },
  };

  return { client, commands, killed };
}

/**
 * A session already holding a client, with syncing stubbed out.
 *
 * This file is about the error contract around a command, not about sync — and
 * a real `syncBefore` here would tar the repository on every test. Sync has its
 * own tests against a temp workspace.
 */
function sessionWith(client: SandboxClient): SandboxSession {
  const { settings } = resolveSandboxSettings({});
  const session = new SandboxSession({
    settings,
    workspace: process.cwd(),
    createSandbox: async () => client,
  });

  const stub = session as unknown as {
    client: () => Promise<SandboxClient>;
    syncBefore: () => Promise<void>;
    syncAfter: () => Promise<void>;
  };
  stub.client = async () => client;
  stub.syncBefore = async () => {};
  stub.syncAfter = async () => {};

  return session;
}

describe("sandbox executor", () => {
  describe("a non-zero exit is a result, not an error", () => {
    test("CommandExitError is unwrapped into a CommandResult", async () => {
      // The landmine. E2B throws for any non-zero exit, and for a coding agent
      // a failing suite is the answer to the question — not a broken sandbox.
      // Unconverted, every red test run would reach the model as an exception.
      const { client } = fakeClient({
        wait: async () => {
          throw new FakeCommandExitError(1, "3 pass\n1 fail\n", "assertion failed");
        },
      });

      const result = await createSandboxExecutor(sessionWith(client)).run("bun test", 30);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("1 fail");
      expect(result.stderr).toContain("assertion failed");
    });

    test("a zero exit comes back the same way", async () => {
      const { client } = fakeClient({
        wait: async () => ({ exitCode: 0, stdout: "all good", stderr: "" }),
      });

      const result = await createSandboxExecutor(sessionWith(client)).run("bun test", 30);

      expect(result).toEqual({ exitCode: 0, stdout: "all good", stderr: "" });
    });

    test("an error carrying no exit code stays an error", async () => {
      // A transport failure must not be mistaken for a command that ran and
      // failed — the model would 'fix' code that never executed.
      const { client } = fakeClient({
        wait: async () => {
          throw new Error("connection reset");
        },
      });

      await expect(
        createSandboxExecutor(sessionWith(client)).run("bun test", 30),
      ).rejects.toThrow(SandboxUnavailableError);
    });
  });

  describe("the wording tools/terminal.ts matches on", () => {
    test("a timeout produces the exact timeout message", async () => {
      const { client, killed } = fakeClient({
        // Never settles on its own, so the executor's timer is what ends it.
        wait: () => new Promise(() => {}),
      });

      await expect(
        createSandboxExecutor(sessionWith(client)).run("sleep 99", 0.05),
      ).rejects.toThrow("Command timed out after 0.05 seconds");

      // The command is killed, not merely stopped being awaited: a survivor
      // would keep writing into the tree the next command reads.
      await Bun.sleep(80);
      expect(killed).toContain(4242);
    });

    test("an abort produces the exact cancellation message, and kills the command", async () => {
      const controller = new AbortController();
      const { client, killed } = fakeClient({ wait: () => new Promise(() => {}) });

      const running = createSandboxExecutor(sessionWith(client)).run(
        "sleep 99",
        30,
        controller.signal,
      );
      await Bun.sleep(10);
      controller.abort();

      await expect(running).rejects.toThrow("Command cancelled");
      await Bun.sleep(20);
      expect(killed).toContain(4242);
    });

    test("a signal already aborted never starts anything", async () => {
      const controller = new AbortController();
      controller.abort();
      const { client, commands } = fakeClient();

      await expect(
        createSandboxExecutor(sessionWith(client)).run("echo hi", 30, controller.signal),
      ).rejects.toThrow("Command cancelled");

      await Bun.sleep(10);
      expect(commands).toEqual([]);
    });
  });

  describe("failing closed", () => {
    test("an unreachable sandbox never falls back to the local executor", async () => {
      const { settings } = resolveSandboxSettings({});
      const session = new SandboxSession({
        settings,
        workspace: process.cwd(),
        createSandbox: async () => {
          throw new Error("network down");
        },
      });

      const error = await createSandboxExecutor(session)
        .run("touch /tmp/should-never-exist", 30)
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(SandboxUnavailableError);
      // The whole point: the command did not quietly run here instead.
      expect(await Bun.file("/tmp/should-never-exist").exists()).toBe(false);
    });

    test("background processes are refused rather than run locally", async () => {
      const { client } = fakeClient();

      await expect(
        createSandboxExecutor(sessionWith(client)).start("npm run dev"),
      ).rejects.toThrow(/not available while the sandbox is on/);
    });
  });

  test("the toolchain path is prepended so a provisioned bun is findable", async () => {
    // `commands.run` is not a login shell, so nothing in .bashrc applies.
    const { client, commands } = fakeClient();

    await createSandboxExecutor(sessionWith(client)).run("bun test", 30);

    expect(commands[0]).toContain(".bun/bin");
    expect(commands[0]).toContain("bun test");
  });

  test("the local executor is a different object, and stays local", () => {
    const { client } = fakeClient();
    expect(createSandboxExecutor(sessionWith(client)).kind).toBe("sandbox");
    expect(localExecutor.kind).toBe("local");
  });
});
