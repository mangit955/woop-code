import { test, expect, describe } from "bun:test";
import { createSandboxExecutor } from "../../../runtime/sandbox/sandboxExecutor";
import {
  SandboxSession,
  SandboxUnavailableError,
  type SandboxClient,
  type SandboxRunOpts,
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
  /** Thrown by `commands.kill`, to prove `terminate` swallows it. */
  killThrows?: Error;
}

function fakeClient(options: FakeOptions = {}) {
  const commands: string[] = [];
  const killed: number[] = [];
  /** The stream callbacks the last `run` was given, so a test can print. */
  const sinks: Array<(data: string) => void> = [];

  const client: SandboxClient = {
    sandboxId: "sbx-fake",
    commands: {
      async run(command: string, opts?: SandboxRunOpts) {
        commands.push(command);
        if (opts?.onStdout) sinks.push(opts.onStdout);
        if (opts?.onStderr) sinks.push(opts.onStderr);
        if (options.runThrows) throw options.runThrows;
        return {
          pid: 4242,
          wait:
            options.wait ??
            (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
        };
      },
      async kill(pid: number) {
        if (options.killThrows) throw options.killThrows;
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
    getHost(port: number) {
      return `${port}-sbx-fake.e2b.app`;
    },
  };

  return { client, commands, killed, sinks };
}

/**
 * A session already holding a client, with syncing stubbed out.
 *
 * This file is about the error contract around a command, not about sync — and
 * a real `syncBefore` here would tar the repository on every test. Sync has its
 * own tests against a temp workspace.
 */
function sessionWith(client: SandboxClient): SandboxSession {
  return recordingSession(client).session;
}

/**
 * The same, with the sync calls counted and the order they ran in kept.
 *
 * For the background path, where *when* the two syncs happen relative to the
 * command is the design rather than an implementation detail.
 */
function recordingSession(
  client: SandboxClient,
  options: { syncAfterThrows?: Error; running?: boolean } = {},
) {
  const { settings } = resolveSandboxSettings({});
  const session = new SandboxSession({
    settings,
    workspace: process.cwd(),
    createSandbox: async () => client,
  });

  const calls: string[] = [];

  const stub = session as unknown as {
    client: () => Promise<SandboxClient>;
    syncBefore: () => Promise<void>;
    syncAfter: () => Promise<void>;
    keepAlive: () => Promise<void>;
  };
  stub.client = async () => client;
  stub.syncBefore = async () => {
    calls.push("before");
  };
  stub.syncAfter = async () => {
    calls.push("after");
    if (options.syncAfterThrows) throw options.syncAfterThrows;
  };
  stub.keepAlive = async () => {
    calls.push("keepAlive");
  };

  // The real getter reads a private client this stub never sets, so it has to
  // be stated: a session standing in for a live one has to look live.
  Object.defineProperty(session, "isRunning", {
    get: () => options.running ?? true,
    configurable: true,
  });

  return { session, calls };
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

    test("a background process on an unreachable sandbox is refused, not run here", async () => {
      const { settings } = resolveSandboxSettings({});
      const session = new SandboxSession({
        settings,
        workspace: process.cwd(),
        createSandbox: async () => {
          throw new Error("network down");
        },
      });

      const error = await createSandboxExecutor(session)
        .start("touch /tmp/should-never-exist-bg")
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(SandboxUnavailableError);
      expect(await Bun.file("/tmp/should-never-exist-bg").exists()).toBe(false);
    });
  });

  describe("background processes", () => {
    /** Never settles, which is what a server does. */
    const running = () => new Promise<never>(() => {});

    test("output printed before anyone is listening is not lost", async () => {
      // The one that bites. E2B takes the stream callbacks when the command
      // starts, but `tools/process.ts` registers its sink after `start()` has
      // returned — so a server's startup banner, the line that says which port
      // it chose, is printed into nothing unless it is buffered until then.
      const { client, sinks } = fakeClient({ wait: running });
      const handle = await createSandboxExecutor(sessionWith(client)).start("bun run site");

      expect(sinks.length).toBeGreaterThan(0);
      sinks[0]!("listening on 3000\n");

      let seen = "";
      handle.onOutput((chunk) => {
        seen += chunk;
      });

      expect(seen).toContain("listening on 3000");
    });

    test("output printed after the sink is attached goes straight through", async () => {
      const { client, sinks } = fakeClient({ wait: running });
      const handle = await createSandboxExecutor(sessionWith(client)).start("bun run site");

      let seen = "";
      handle.onOutput((chunk) => {
        seen += chunk;
      });
      sinks[0]!("a request arrived\n");

      expect(seen).toContain("a request arrived");
    });

    test("stdout and stderr arrive as one transcript", async () => {
      const { client, sinks } = fakeClient({ wait: running });
      const handle = await createSandboxExecutor(sessionWith(client)).start("bun run site");

      let seen = "";
      handle.onOutput((chunk) => {
        seen += chunk;
      });
      // Two callbacks were registered; both feed the one sink.
      for (const sink of sinks) sink("x");

      expect(seen).toBe("x".repeat(sinks.length));
      expect(sinks.length).toBe(2);
    });

    test("an exit that arrives by being thrown is still an exit code", async () => {
      // The same landmine `run` has: a killed server exits non-zero, and E2B
      // reports every non-zero exit by throwing. Read only the resolution and a
      // dead process reports itself as running forever.
      const { client } = fakeClient({
        wait: async () => {
          throw new FakeCommandExitError(137, "", "killed");
        },
      });

      const handle = await createSandboxExecutor(sessionWith(client)).start("bun run site");

      expect(await handle.exited).toBe(137);
      expect(handle.exitCode).toBe(137);
    });

    test("terminate kills the remote process and never throws", async () => {
      const { client, killed } = fakeClient({ wait: running });
      const handle = await createSandboxExecutor(sessionWith(client)).start("bun run site");

      handle.terminate();
      await Bun.sleep(10);

      expect(killed).toContain(4242);
    });

    test("terminate stays silent when the sandbox is already gone", async () => {
      // `stopAllProcesses` runs at session exit and cannot await or catch, so a
      // throw here would take the teardown down with it.
      const { client } = fakeClient({
        wait: running,
        killThrows: new Error("sandbox not found"),
      });
      const handle = await createSandboxExecutor(sessionWith(client)).start("bun run site");

      expect(() => handle.terminate()).not.toThrow();
      await Bun.sleep(10);
    });

    test("the tree goes in before it starts and comes back when it is stopped", async () => {
      const { client } = fakeClient({ wait: running });
      const { session, calls } = recordingSession(client);

      const handle = await createSandboxExecutor(session).start("bun run build --watch");

      // Pushed, so it builds the file the user edited a moment ago. Not yet
      // pulled: it has not written anything.
      expect(calls).toEqual(["keepAlive", "before"]);

      const note = await handle.syncBack!();

      expect(calls).toEqual(["keepAlive", "before", "after"]);
      expect(note).toBe("");
    });

    test("a failed pull is reported rather than thrown", async () => {
      // Losing the process's output on top of losing its files helps nobody,
      // and `process_stop` has already killed the process by this point.
      const { client } = fakeClient({ wait: running });
      const { session } = recordingSession(client, {
        syncAfterThrows: new Error("listing failed"),
      });

      const handle = await createSandboxExecutor(session).start("bun run build --watch");
      const note = await handle.syncBack!();

      expect(note).toContain("listing failed");
      expect(note).toContain("Local files are unchanged");
    });

    test("stopping a process whose sandbox is already gone does not start a new one", async () => {
      // `/sandbox off` disposes the session and resets the executor, but the
      // handles already handed out stay in `tools/process.ts`'s map. Reaching
      // `session.client()` from one of them would create a sandbox the user has
      // just turned off, and then pull against a snapshot taken before all of
      // it — a sync nobody asked for against a reference that describes nothing.
      const { client } = fakeClient({ wait: running });
      let created = 0;
      const { settings } = resolveSandboxSettings({});
      const session = new SandboxSession({
        settings,
        workspace: process.cwd(),
        createSandbox: async () => {
          created++;
          return client;
        },
      });
      const stub = session as unknown as {
        client: () => Promise<SandboxClient>;
        syncBefore: () => Promise<void>;
      };
      stub.client = async () => {
        created++;
        return client;
      };
      stub.syncBefore = async () => {};

      const handle = await createSandboxExecutor(session).start("bun run site");
      expect(created).toBe(1);

      // The sandbox goes away underneath the running process.
      await session.dispose();

      const note = await handle.syncBack!();

      expect(created).toBe(1);
      expect(note).toContain("shut down");
      expect(note).toContain("Local files are unchanged");
    });

    test("the toolchain path is prepended for a background command too", async () => {
      const { client, commands } = fakeClient({ wait: running });
      await createSandboxExecutor(sessionWith(client)).start("bun run site");

      expect(commands[0]).toContain(".bun/bin");
      expect(commands[0]).toContain("bun run site");
    });
  });

  describe("reaching a port inside the sandbox", () => {
    test("the URL is E2B's published host, over https", async () => {
      // E2B terminates TLS at its proxy, so the URL is https even though the
      // server inside is listening on plain http.
      const { client } = fakeClient();

      const url = await createSandboxExecutor(sessionWith(client)).urlForPort(3000);

      expect(url).toBe("https://3000-sbx-fake.e2b.app");
    });

    test("a sandbox that cannot publish a port says so rather than guessing", async () => {
      const { client } = fakeClient();
      const without = { ...client } as Partial<SandboxClient>;
      delete without.getHost;

      await expect(
        createSandboxExecutor(sessionWith(without as SandboxClient)).urlForPort(3000),
      ).rejects.toThrow(SandboxUnavailableError);
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
