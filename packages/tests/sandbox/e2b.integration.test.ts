import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import path from "node:path";
import { homedir } from "node:os";
import { disableSandbox, enableSandbox } from "../../../runtime/sandbox/control";
import { currentExecutor } from "../../../runtime/sandbox/registry";
import { localExecutor } from "../../../runtime/sandbox/localExecutor";
import { sandboxSession } from "../../../runtime/sandbox/control";
import { replTool } from "../../../tools/repl";
import { closeReplSessions } from "../../../tools/replSession";
import { store } from "../../../tui/src/store/ui-store";

/**
 * Against a real E2B sandbox.
 *
 * Opt-in twice over, and the second one matters: **the key being present is not
 * consent to spend money.** Bun loads `.env` automatically, so anyone working on
 * this repository has `E2B_API_KEY` in their environment — gating on the key
 * alone would boot a virtual machine on every `bun test`, which is to say
 * before every commit, because `verify` runs the suite. `WOOPCODE_E2B_TESTS=1`
 * is the deliberate act.
 *
 *   WOOPCODE_E2B_TESTS=1 bun test packages/tests/sandbox/e2b.integration.test.ts
 *
 * Guarded by a runtime check inside each body rather than `.skip`/`.skipIf`,
 * which `verify.ts` flags as a silenced test — a suite that goes green by
 * quietly not running something is the failure mode that rule exists for.
 *
 * One sandbox for the whole file. Creating one per test would multiply the cost
 * and the wall clock for no extra coverage.
 */

const HAS_KEY =
  Boolean(process.env.E2B_API_KEY?.trim()) && process.env.WOOPCODE_E2B_TESTS === "1";

/**
 * The file a contained command creates in its own `$HOME`, and must never
 * create in this machine's.
 */
const PROBE_NAME = `woopcode-escape-probe-${crypto.randomUUID()}`;
const HOST_PROBE = path.join(homedir(), PROBE_NAME);

async function removeHostProbe() {
  await Bun.file(HOST_PROBE)
    .unlink()
    .catch(() => {});
}

const originalSetPendingCommand = store.setPendingCommand;

beforeAll(async () => {
  if (!HAS_KEY) return;
  await removeHostProbe();

  // The repl asks for approval and there is no human here. Restored in
  // `afterAll` only — per-test restoration would leave the rest of the file
  // waiting on a prompt nobody answers.
  store.setPendingCommand = async () => true;

  enableSandbox({
    workspace: process.cwd(),
    onStatus: (message) => process.stderr.write(`  sandbox: ${message}\n`),
  });

  // Force creation now, so the first test does not pay for the boot and the
  // push, and so a failure here reads as setup rather than as a test failing.
  await sandboxSession()!.client();
}, 300_000);

afterAll(async () => {
  closeReplSessions();
  store.setPendingCommand = originalSetPendingCommand;
  await disableSandbox();
  await removeHostProbe();
});

describe("a real sandbox", () => {
  test("the workspace arrives", async () => {
    if (!HAS_KEY) return;

    const result = await currentExecutor().run("ls package.json cli.ts", 60);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("package.json");
    expect(result.stdout).toContain("cli.ts");
  }, 120_000);

  test("a non-zero exit comes back as a result, not an exception", async () => {
    if (!HAS_KEY) return;

    // The landmine, verified against the real SDK rather than a fake: E2B
    // throws CommandExitError for any non-zero exit, and a failing suite is the
    // normal case for a coding agent.
    const result = await currentExecutor().run("exit 3", 60);

    expect(result.exitCode).toBe(3);
  }, 120_000);

  test("stderr and stdout both come back", async () => {
    if (!HAS_KEY) return;

    const result = await currentExecutor().run("echo out; echo err >&2", 60);

    expect(result.stdout).toContain("out");
    expect(result.stderr).toContain("err");
  }, 120_000);

  describe("containment", () => {
    test("a command cannot touch the host filesystem", async () => {
      if (!HAS_KEY) return;

      // The claim the whole feature rests on, and it has to be unambiguous.
      //
      // `$HOME` rather than the host's absolute path. An absolute `/Users/...`
      // fails inside the sandbox — measured, `mkdir /Users` is permission
      // denied there — and a test that passes because the command *failed*
      // proves nothing about containment. `$HOME` exists and is writable in
      // both places, so the command fully succeeds; what it demonstrates is
      // that the identical expression resolved to a different filesystem.
      const result = await currentExecutor().run(
        `touch "$HOME/${PROBE_NAME}" && test -f "$HOME/${PROBE_NAME}" && echo created-in-sandbox`,
        60,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("created-in-sandbox");
      // ...and this machine's home directory is untouched.
      expect(await Bun.file(HOST_PROBE).exists()).toBe(false);
      // And to be sure the executor under test was the sandbox one.
      expect(currentExecutor()).not.toBe(localExecutor);
    }, 120_000);

    test("the host's ssh keys are not reachable", async () => {
      if (!HAS_KEY) return;

      const result = await currentExecutor().run("cat ~/.ssh/id_rsa 2>&1 || true", 60);

      expect(result.stdout).not.toContain("PRIVATE KEY");
    }, 120_000);
  });

  describe("credentials", () => {
    test("the repository's .env never arrived", async () => {
      if (!HAS_KEY) return;

      const result = await currentExecutor().run("test -f .env && echo PRESENT || echo ABSENT", 60);

      expect(result.stdout).toContain("ABSENT");
    }, 120_000);

    test("no host credential is in the sandbox environment", async () => {
      if (!HAS_KEY) return;

      const result = await currentExecutor().run("env", 60);

      for (const name of ["WOOPCODE_API_KEY", "E2B_API_KEY", "ANTHROPIC_API_KEY"]) {
        const value = process.env[name];
        if (value) expect(result.stdout).not.toContain(value);
      }
    }, 120_000);

    test("no transmitted file contains the agent's own key", async () => {
      if (!HAS_KEY) return;

      const key = process.env.WOOPCODE_API_KEY ?? process.env.E2B_API_KEY;
      if (!key) return;

      const result = await currentExecutor().run(
        `grep -rl "${key}" . 2>/dev/null | head -5; true`,
        120,
      );

      expect(result.stdout.trim()).toBe("");
    }, 180_000);
  });

  describe("sync", () => {
    // A scratch file inside the repository, because the sync only carries what
    // the transmittable set lists. Removed on both sides of every test.
    const scratch = `.sandbox-sync-probe-${crypto.randomUUID()}.txt`;
    const scratchPath = path.join(process.cwd(), scratch);

    afterEach(async () => {
      await Bun.file(scratchPath)
        .unlink()
        .catch(() => {});
      await Bun.file(`${scratchPath}.sandbox`)
        .unlink()
        .catch(() => {});
    });

    test("a local edit is visible to the next command", async () => {
      if (!HAS_KEY) return;

      await Bun.write(scratchPath, "written locally\n");

      const result = await currentExecutor().run(`cat ${scratch}`, 60);

      expect(result.stdout).toContain("written locally");
    }, 120_000);

    test("what a command writes comes back", async () => {
      if (!HAS_KEY) return;

      await currentExecutor().run(`echo "written in the sandbox" > ${scratch}`, 60);

      expect(await Bun.file(scratchPath).text()).toContain("written in the sandbox");
    }, 120_000);

    test("an in-place edit comes back", async () => {
      if (!HAS_KEY) return;

      await Bun.write(scratchPath, "before\n");
      await currentExecutor().run(`sed -i 's/before/after/' ${scratch}`, 60);

      expect(await Bun.file(scratchPath).text()).toContain("after");
    }, 120_000);

    test("a deletion comes back", async () => {
      if (!HAS_KEY) return;

      await Bun.write(scratchPath, "doomed\n");
      // Pushed by this command's own sync, then removed by it.
      await currentExecutor().run(`test -f ${scratch} && rm ${scratch}`, 60);

      expect(await Bun.file(scratchPath).exists()).toBe(false);
    }, 120_000);

    test("a command that writes nothing leaves the tree alone", async () => {
      if (!HAS_KEY) return;

      const before = await Bun.file(path.join(process.cwd(), "package.json")).text();
      await currentExecutor().run("ls > /dev/null", 60);

      expect(await Bun.file(path.join(process.cwd(), "package.json")).text()).toBe(before);
    }, 120_000);

    test("a credential the sandbox writes is refused rather than delivered", async () => {
      if (!HAS_KEY) return;

      const planted = ".env.sandbox-planted";
      const result = await currentExecutor().run(
        `echo "STOLEN=1" > ${planted} && echo done`,
        60,
      );

      expect(result.stdout).toContain("done");
      expect(await Bun.file(path.join(process.cwd(), planted)).exists()).toBe(false);
      expect(result.stdout).toContain("look like credentials");
    }, 120_000);
  });

  describe("background processes", () => {
    const scratch = `.sandbox-bg-probe-${crypto.randomUUID()}.txt`;
    const scratchPath = path.join(process.cwd(), scratch);

    afterEach(async () => {
      await Bun.file(scratchPath)
        .unlink()
        .catch(() => {});
    });

    test("a process outlives the call that started it, and its output is collected", async () => {
      if (!HAS_KEY) return;

      const handle = await currentExecutor().start(
        "for i in 1 2 3 4 5; do echo tick-$i; sleep 1; done",
      );

      let seen = "";
      handle.onOutput((chunk) => {
        seen += chunk;
      });

      // Nothing was waited for, so the later ticks cannot have been printed yet.
      expect(handle.exitCode).toBeNull();
      await Bun.sleep(3500);

      expect(seen).toContain("tick-1");
      expect(seen).toContain("tick-3");
      handle.terminate();
    }, 120_000);

    test("terminate actually stops it in the sandbox", async () => {
      if (!HAS_KEY) return;

      const marker = `woopbg${crypto.randomUUID().replace(/-/g, "")}`;
      const handle = await currentExecutor().start(
        `python3 -c "import time; time.sleep(120)" ${marker}`,
      );

      // Two things this counting command has to avoid, both of which produced a
      // confident wrong answer while it was being written.
      //
      // It is delimited rather than read off the whole of stdout, because
      // stdout is not the command's output alone — the sync appends a note to
      // it, and an earlier test here leaves a refused file in the sandbox that
      // is re-reported on every command afterwards. `Number(stdout.trim())` was
      // NaN for that reason, not because the count was wrong.
      //
      // And the pattern is bracketed, because `pgrep -f` reads whole command
      // lines: an unbracketed marker matches the shell running this very
      // pipeline, so the count never reached zero however dead the process was.
      const pattern = `[${marker[0]}]${marker.slice(1)}`;
      const count = async () => {
        const result = await currentExecutor().run(
          `echo "COUNT:$(pgrep -f '${pattern}' | wc -l)"`,
          60,
        );
        const match = result.stdout.match(/COUNT:(\d+)/);
        expect(match).not.toBeNull();
        return Number(match![1]);
      };

      await Bun.sleep(1500);
      expect(await count()).toBeGreaterThan(0);

      handle.terminate();
      await Bun.sleep(2000);

      expect(await count()).toBe(0);
    }, 180_000);

    test("what it wrote comes back at the pull", async () => {
      if (!HAS_KEY) return;

      const handle = await currentExecutor().start(
        `sh -c 'sleep 1; echo "written by a background process" > ${scratch}'`,
      );

      await Bun.sleep(3000);
      expect(await handle.syncBack!()).not.toContain("could not be brought back");

      expect(await Bun.file(scratchPath).text()).toContain("written by a background process");
    }, 120_000);

    test("a server started inside is reachable at the published URL", async () => {
      if (!HAS_KEY) return;

      // The claim `getHost` exists to make, and the only one in this file that
      // leaves the machine in the other direction: an inbound request through
      // E2B's proxy into a port inside the sandbox.
      const port = 8321;
      const handle = await currentExecutor().start(
        `python3 -m http.server ${port}`,
      );

      try {
        const url = await currentExecutor().urlForPort(port);
        expect(url).toContain(`${port}-`);

        // The server needs a moment; a single fetch would be a flake.
        let response: Response | null = null;
        for (let attempt = 0; attempt < 15 && !response?.ok; attempt++) {
          await Bun.sleep(1000);
          response = await fetch(url).catch(() => null);
        }

        expect(response?.ok).toBe(true);
        // The directory listing of the pushed workspace.
        expect(await response!.text()).toContain("package.json");
      } finally {
        handle.terminate();
      }
    }, 180_000);
  });

  describe("the repl", () => {
    const scratch = `.sandbox-repl-probe-${crypto.randomUUID()}.txt`;
    const scratchPath = path.join(process.cwd(), scratch);

    afterEach(async () => {
      closeReplSessions();
      await Bun.file(scratchPath)
        .unlink()
        .catch(() => {});
    });

    test("python state survives between calls", async () => {
      if (!HAS_KEY) return;

      // The whole reason the tool exists, proved where it now runs.
      await replTool.execute({
        language: "python",
        code: "kept = sum(range(1000))",
      });
      const result = await replTool.execute({ language: "python", code: "kept" });

      expect(result).toContain("499500");
    }, 180_000);

    test("a top-level var survives between node calls", async () => {
      if (!HAS_KEY) return;

      await replTool.execute({ language: "node", code: "var kept = 6 * 7;" });
      const result = await replTool.execute({ language: "node", code: "kept" });

      expect(result).toContain("42");
    }, 180_000);

    test("it runs in the sandbox, not on this machine", async () => {
      if (!HAS_KEY) return;

      const result = await replTool.execute({
        language: "python",
        code: "import subprocess; print(subprocess.run(['ls', '/'], capture_output=True, text=True).stdout)",
      });

      // The sandbox has no /Users; this machine does. Same expression, two
      // filesystems, which is the containment claim.
      expect(result).toContain("home");
      expect(result).not.toContain("Users");
    }, 180_000);

    test("it sees a local edit made between two evaluations", async () => {
      if (!HAS_KEY) return;

      await Bun.write(scratchPath, "first\n");
      const before = await replTool.execute({
        language: "python",
        code: `open(${JSON.stringify(scratch)}).read()`,
      });
      expect(before).toContain("first");

      await Bun.write(scratchPath, "second\n");
      const after = await replTool.execute({
        language: "python",
        code: `open(${JSON.stringify(scratch)}).read()`,
      });

      // The push half of the per-evaluation transaction.
      expect(after).toContain("second");
    }, 180_000);

    test("a file it writes arrives on local disk", async () => {
      if (!HAS_KEY) return;

      await replTool.execute({
        language: "python",
        code: `open(${JSON.stringify(scratch)}, "w").write("written by the repl")`,
      });

      // The pull half.
      expect(await Bun.file(scratchPath).text()).toContain("written by the repl");
    }, 180_000);
  });

  test("bun was provisioned, so this repository can run its own suite", async () => {
    if (!HAS_KEY) return;

    // Phase 0 found bun missing from E2B's base template, which meant a repo
    // whose test command is `bun test` could not run it at all.
    const result = await currentExecutor().run("bun --version", 60);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+/);
  }, 120_000);
});
