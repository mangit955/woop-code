import { test, expect, describe } from "bun:test";
import { createSandboxReplTransport } from "../../../runtime/sandbox/sandboxRepl";
import {
  SandboxSession,
  SandboxUnavailableError,
  type SandboxClient,
} from "../../../runtime/sandbox/session";
import { resolveSandboxSettings } from "../../../runtime/sandbox/settings";
import { ReplUnavailableError } from "../../../tools/replDrivers";
import { fakeSandboxClient } from "../shared/fakeSandbox";

/**
 * The interpreter transport, against a fake E2B client.
 *
 * No network and no key, so all of this runs in CI — which matters, because
 * every rule here fails silently rather than loudly. A transport that loses the
 * first frame, or takes the driver's own path as its sentinel, does not throw:
 * it hangs until a two-minute timeout and reports a lost session, which reads
 * like a slow interpreter rather than a broken one.
 */

/** A session already holding a client, with syncing stubbed out. */
function sessionWith(
  client: SandboxClient,
  options: { running?: boolean } = {},
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
  };
  stub.keepAlive = async () => {
    calls.push("keepAlive");
  };

  Object.defineProperty(session, "isRunning", {
    get: () => options.running ?? true,
    configurable: true,
  });

  return { session, calls };
}

const launch = { language: "python" as const, sentinel: "__SENT__" };

describe("an interpreter inside the sandbox", () => {
  test("the driver is written as a file and the command points at it", async () => {
    // Not passed as an argument. E2B takes a command *string*, and this source
    // is a hundred lines of Python full of quotes, backslashes and newlines;
    // shell-quoting it into a string is a bug farm with no upside.
    const fake = fakeSandboxClient();
    await createSandboxReplTransport(sessionWith(fake.client).session, launch);

    const paths = [...fake.written.keys()];
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^\/tmp\/woopcode-repl-.*\.py$/);
    expect(fake.written.get(paths[0]!)).toContain("import sys, json, io, ast, traceback");

    const start = fake.commands.at(-1)!;
    expect(start).toContain(paths[0]!);
    // The source itself is nowhere near the command line.
    expect(start).not.toContain("traceback");
  });

  test("the sentinel is the last argument, where both drivers read it from", async () => {
    // Pinned to argv[1] instead, node would take the driver's own path as its
    // sentinel from a file — no frame would ever match and every evaluation
    // would hang until its timeout rather than fail.
    const fake = fakeSandboxClient();
    await createSandboxReplTransport(sessionWith(fake.client).session, {
      language: "node",
      sentinel: "__NODE_SENT__",
    });

    expect(fake.commands.at(-1)!.trim().endsWith("__NODE_SENT__")).toBe(true);
  });

  test("the driver file is outside the workspace, so it never syncs back", async () => {
    const fake = fakeSandboxClient();
    await createSandboxReplTransport(sessionWith(fake.client).session, launch);

    for (const path of fake.written.keys()) {
      expect(path.startsWith("/tmp/")).toBe(true);
    }
  });

  test("it runs in the workspace, so a relative path means what it means locally", async () => {
    const fake = fakeSandboxClient();
    const opts: string[] = [];
    const client: SandboxClient = {
      ...fake.client,
      commands: {
        ...fake.client.commands,
        async run(command, options) {
          if (options?.background) opts.push(options.cwd ?? "<none>");
          return fake.client.commands.run(command, options);
        },
      },
    };

    await createSandboxReplTransport(sessionWith(client).session, launch);

    expect(opts).toEqual(["/home/user/workspace"]);
  });

  test("source reaches the interpreter and its frame comes back", async () => {
    const fake = fakeSandboxClient({ onEval: (source) => `evaluated: ${source}` });
    const transport = await createSandboxReplTransport(
      sessionWith(fake.client).session,
      launch,
    );

    await transport.write(`${JSON.stringify("1 + 1")}\n`);

    expect(fake.evaluated).toEqual(["1 + 1"]);
    expect(await transport.read()).toContain("evaluated: 1 + 1");
  });

  test("output that arrives before the first read is not lost", async () => {
    // E2B pushes through onStdout from the moment the command starts, so a
    // frame can be complete before anything asks for it. The same lesson as
    // background processes, and here the lost bytes are a whole result.
    const fake = fakeSandboxClient();
    const transport = await createSandboxReplTransport(
      sessionWith(fake.client).session,
      launch,
    );

    fake.emit("printed before anyone read\n");

    expect(await transport.read()).toBe("printed before anyone read\n");
  });

  test("reads queue up in the order the chunks arrived", async () => {
    const fake = fakeSandboxClient();
    const transport = await createSandboxReplTransport(
      sessionWith(fake.client).session,
      launch,
    );

    fake.emit("first\n");
    fake.emit("second\n");

    expect(await transport.read()).toBe("first\n");
    expect(await transport.read()).toBe("second\n");
  });

  test("a read waiting on nothing is answered when a chunk arrives", async () => {
    const fake = fakeSandboxClient();
    const transport = await createSandboxReplTransport(
      sessionWith(fake.client).session,
      launch,
    );

    const pending = transport.read();
    await Bun.sleep(10);
    fake.emit("late\n");

    expect(await pending).toBe("late\n");
  });

  test("an interpreter that dies stops the reader rather than hanging it", async () => {
    const fake = fakeSandboxClient();
    const transport = await createSandboxReplTransport(
      sessionWith(fake.client).session,
      launch,
    );

    transport.close();

    // null, not a chunk and not forever: `replSession` turns this into "the
    // interpreter exited", which is an answer the model can act on.
    expect(await transport.read()).toBeNull();
  });

  test("close ends stdin and kills, and never throws when the sandbox is gone", async () => {
    // `closeReplSessions` runs in the agent loop's `finally` on every exit a
    // turn has, and can neither await nor catch.
    const fake = fakeSandboxClient({ killThrows: new Error("sandbox not found") });
    const transport = await createSandboxReplTransport(
      sessionWith(fake.client).session,
      launch,
    );

    expect(() => transport.close()).not.toThrow();
    await Bun.sleep(10);
    expect(fake.stdinClosed).toHaveLength(1);
  });

  test("no interpreter in the sandbox says so, naming what it looked for", async () => {
    const fake = fakeSandboxClient({ interpreters: [] });

    await expect(
      createSandboxReplTransport(sessionWith(fake.client).session, launch),
    ).rejects.toThrow(ReplUnavailableError);
  });

  test("a client that cannot hold stdin open is a sandbox failure, not a repl one", async () => {
    const fake = fakeSandboxClient();
    const client: SandboxClient = {
      ...fake.client,
      commands: {
        ...fake.client.commands,
        async run(command, options) {
          const started = await fake.client.commands.run(command, options);
          if (options?.background) {
            const { sendStdin, closeStdin, ...rest } = started as Record<string, unknown>;
            return rest;
          }
          return started;
        },
      },
    };

    await expect(
      createSandboxReplTransport(sessionWith(client).session, launch),
    ).rejects.toThrow(SandboxUnavailableError);
  });

  describe("sync around an evaluation", () => {
    test("the tree goes in before the code runs and comes back after", async () => {
      const fake = fakeSandboxClient();
      const { session, calls } = sessionWith(fake.client);
      const transport = await createSandboxReplTransport(session, launch);

      const before = calls.length;
      await transport.beforeEval!();
      // The lease is renewed too: a turn of nothing but repl calls issues no
      // commands, and the lease is refreshed per command.
      expect(calls.slice(before)).toEqual(["keepAlive", "before"]);

      expect(await transport.afterEval!()).toBe("");
      expect(calls.at(-1)).toBe("after");
    });

    test("a pull after the sandbox is gone reports it instead of creating one", async () => {
      // The Phase 4 defect, in its repl shape: `session.syncAfter` reaches
      // `session.client()`, which *creates* a sandbox the user turned off.
      let created = 0;
      const fake = fakeSandboxClient();
      const { settings } = resolveSandboxSettings({});
      const session = new SandboxSession({
        settings,
        workspace: process.cwd(),
        createSandbox: async () => {
          created++;
          return fake.client;
        },
      });
      const stub = session as unknown as {
        client: () => Promise<SandboxClient>;
        syncBefore: () => Promise<void>;
      };
      stub.client = async () => {
        created++;
        return fake.client;
      };
      stub.syncBefore = async () => {};

      const transport = await createSandboxReplTransport(session, launch);
      expect(created).toBe(1);

      await session.dispose();
      const note = await transport.afterEval!();

      expect(created).toBe(1);
      expect(note).toContain("shut down");
    });
  });
});
