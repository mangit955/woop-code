import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `onboarding/test-reset.ts` is the documented way to reach a first-run state,
 * and it was broken for long enough that nobody noticed: it pointed at
 * `./config/providers.json`, a path inside the repository where configuration
 * has never lived, and raised ENOENT on every invocation. It is listed in
 * CLAUDE.md's command table, so the only thing standing between it and silence
 * was somebody running it by hand.
 *
 * Driven as a subprocess rather than imported, because the script resolves the
 * config directory at module load and acts at the top level — importing it
 * would run it against whatever `XDG_CONFIG_HOME` said at that moment. Spawning
 * also tests the contract a developer actually uses.
 *
 * `XDG_CONFIG_HOME` is passed per spawn rather than assigned to `process.env`,
 * so there is no window in which this file's redirect is visible to another
 * test — and nothing to restore afterwards, which is the failure mode
 * `approval.integration.test.ts` had.
 */

const SCRIPT = join(import.meta.dir, "../../../onboarding/test-reset.ts");

const fixtures: string[] = [];

function makeConfigHome(): { configHome: string; woopcode: string } {
  // A UUID, not Date.now(): millisecond resolution lets two runs build the same
  // path and delete each other's files.
  const configHome = join(tmpdir(), `woop-reset-${crypto.randomUUID()}`);
  const woopcode = join(configHome, "woopcode");
  mkdirSync(woopcode, { recursive: true });
  fixtures.push(configHome);
  return { configHome, woopcode };
}

async function run(configHome: string, ...args: string[]) {
  const proc = Bun.spawn({
    cmd: ["bun", SCRIPT, ...args],
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("onboarding test-reset", () => {
  test("moves the real config directory aside and puts it back", async () => {
    const { configHome, woopcode } = makeConfigHome();
    const providers = join(woopcode, "providers.json");
    const conversation = join(woopcode, "conversation.json");
    await Bun.write(providers, '{"defaultProvider":"google"}');
    await Bun.write(conversation, '["real history"]');

    const reset = await run(configHome);
    expect(reset.exitCode).toBe(0);

    // A missing directory is the cold start: `ensureProviderConfigured` finds no
    // usable provider and the wizard runs.
    expect(existsSync(woopcode)).toBe(false);

    // Whatever the wizard would have written is test data, and must not survive
    // the restore.
    mkdirSync(woopcode, { recursive: true });
    await Bun.write(providers, '{"defaultProvider":"throwaway"}');

    const restore = await run(configHome, "restore");
    expect(restore.exitCode).toBe(0);
    expect(await Bun.file(providers).text()).toBe('{"defaultProvider":"google"}');
    expect(await Bun.file(conversation).text()).toBe('["real history"]');
  });

  test("refuses a second reset rather than overwriting the backup", async () => {
    const { configHome, woopcode } = makeConfigHome();
    await Bun.write(join(woopcode, "providers.json"), '{"defaultProvider":"google"}');

    expect((await run(configHome)).exitCode).toBe(0);

    // The second reset would move an empty or wizard-written directory over the
    // one holding the developer's real key.
    mkdirSync(woopcode, { recursive: true });
    const second = await run(configHome);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("backup is already sitting");
  });

  test("reports a restore with nothing to restore", async () => {
    const { configHome } = makeConfigHome();

    const restore = await run(configHome, "restore");
    expect(restore.exitCode).toBe(1);
    expect(restore.stderr).toContain("No backup");
  });
});
