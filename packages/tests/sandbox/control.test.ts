import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import {
  disableSandbox,
  enableSandbox,
  isSandboxEnabled,
  sandboxSession,
} from "../../../runtime/sandbox/control";
import { currentExecutor, isSandboxed } from "../../../runtime/sandbox/registry";
import type { SandboxClient } from "../../../runtime/sandbox/session";
import { replTool } from "../../../tools/repl";
import { store } from "../../../tui/src/store/ui-store";

/**
 * Turning the sandbox on and off, and what refuses to run while it is on.
 *
 * The refusals are the load-bearing part. A sandbox that contains
 * `run_terminal` while `repl` still runs locally is not a sandbox: the model
 * has `subprocess.run` and walks straight out through the tool that was left
 * behind. That is why this is tested at the tool, not at the policy.
 */

function fakeClient(): SandboxClient {
  return {
    sandboxId: "sbx-control",
    commands: {
      async run() {
        return { pid: 1, wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
      },
      async kill() {
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
      return `${port}-sbx-control.e2b.app`;
    },
  };
}

describe("sandbox control", () => {
  const originalSetPendingCommand = store.setPendingCommand;

  beforeEach(() => {
    store.setPendingCommand = async () => true;
  });

  afterEach(async () => {
    store.setPendingCommand = originalSetPendingCommand;
    // Module state outlives the file; a sandbox left enabled would point the
    // rest of the run at a fake.
    await disableSandbox();
  });

  test("enabling routes commands away from this machine", () => {
    expect(isSandboxed()).toBe(false);

    enableSandbox({ createSandbox: async () => fakeClient(), env: {} });

    expect(isSandboxEnabled()).toBe(true);
    expect(isSandboxed()).toBe(true);
    expect(currentExecutor().kind).toBe("sandbox");
  });

  test("enabling creates no sandbox until a command needs one", () => {
    let created = 0;
    enableSandbox({
      env: {},
      createSandbox: async () => {
        created++;
        return fakeClient();
      },
    });

    // A conversation that only reads files should not wait for a virtual
    // machine to boot, or pay for one.
    expect(created).toBe(0);
    expect(sandboxSession()?.isRunning).toBe(false);
  });

  test("disabling puts commands back on this machine", async () => {
    enableSandbox({ createSandbox: async () => fakeClient(), env: {} });
    await disableSandbox();

    expect(isSandboxEnabled()).toBe(false);
    expect(isSandboxed()).toBe(false);
    expect(currentExecutor().kind).toBe("local");
  });

  test("enabling twice does not strand the first sandbox", async () => {
    const killed: string[] = [];
    const client = (id: string): SandboxClient => ({
      ...fakeClient(),
      sandboxId: id,
      async kill() {
        killed.push(id);
        return true;
      },
    });

    enableSandbox({ createSandbox: async () => client("first"), env: {} });
    await sandboxSession()!.client();

    enableSandbox({ createSandbox: async () => client("second"), env: {} });
    // The first sandbox bills until its own timeout otherwise, holding a copy
    // of the workspace nobody is reading.
    await Bun.sleep(20);
    expect(killed).toContain("first");
  });

  test("refused environment names are reported to the caller", () => {
    const { refusedEnv } = enableSandbox({
      createSandbox: async () => fakeClient(),
      env: { WOOPCODE_SANDBOX_ENV: "WOOPCODE_API_KEY", WOOPCODE_API_KEY: "sk-x" },
    });

    expect(refusedEnv).toEqual(["WOOPCODE_API_KEY"]);
  });
});

describe("repl fails closed while sandboxed", () => {
  const originalSetPendingCommand = store.setPendingCommand;

  beforeEach(() => {
    store.setPendingCommand = async () => true;
  });

  afterEach(async () => {
    store.setPendingCommand = originalSetPendingCommand;
    await disableSandbox();
  });

  test("the repl refuses rather than running code on this machine", async () => {
    enableSandbox({ createSandbox: async () => fakeClient(), env: {} });

    const result = await replTool.execute({
      language: "python",
      code: "import os; os.system('touch /tmp/repl-escape-probe')",
    });

    expect(result).toContain("not available while the sandbox is on");
    expect(await Bun.file("/tmp/repl-escape-probe").exists()).toBe(false);
  });

  test("it refuses before asking the user to approve anything", async () => {
    // Being asked to confirm something that will not run either way trains a
    // user to click through prompts.
    let asked = false;
    store.setPendingCommand = async () => {
      asked = true;
      return true;
    };
    enableSandbox({ createSandbox: async () => fakeClient(), env: {} });

    await replTool.execute({ language: "node", code: "1 + 1" });

    expect(asked).toBe(false);
  });

  test("and runs normally again once the sandbox is off", async () => {
    enableSandbox({ createSandbox: async () => fakeClient(), env: {} });
    await disableSandbox();

    const result = await replTool.execute({ language: "python", code: "6 * 7" });

    expect(result).toContain("42");
  });
});
