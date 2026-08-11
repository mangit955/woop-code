import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import path from "node:path";
import { homedir } from "node:os";
import { disableSandbox, enableSandbox } from "../../../runtime/sandbox/control";
import { currentExecutor } from "../../../runtime/sandbox/registry";
import { localExecutor } from "../../../runtime/sandbox/localExecutor";
import { sandboxSession } from "../../../runtime/sandbox/control";

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

beforeAll(async () => {
  if (!HAS_KEY) return;
  await removeHostProbe();

  enableSandbox({
    workspace: process.cwd(),
    onStatus: (message) => process.stderr.write(`  sandbox: ${message}\n`),
  });

  // Force creation now, so the first test does not pay for the boot and the
  // push, and so a failure here reads as setup rather than as a test failing.
  await sandboxSession()!.client();
}, 300_000);

afterAll(async () => {
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

  test("bun was provisioned, so this repository can run its own suite", async () => {
    if (!HAS_KEY) return;

    // Phase 0 found bun missing from E2B's base template, which meant a repo
    // whose test command is `bun test` could not run it at all.
    const result = await currentExecutor().run("bun --version", 60);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+/);
  }, 120_000);
});
