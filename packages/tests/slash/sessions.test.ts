import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlashCommandContext } from "../../../commands/slash/types";

const previousConfigHome = process.env.XDG_CONFIG_HOME;
const configHome = mkdtempSync(join(tmpdir(), `woopcode-slash-sessions-${crypto.randomUUID()}-`));
process.env.XDG_CONFIG_HOME = configHome;

const { registry } = await import("../../../commands/slash/registry");
const { registerCommands } = await import("../../../commands/slash/commands");
const { createSession, listSessions, loadSession, resetSessionStoreForTests, saveSession } =
  await import("../../../config/sessions");

registerCommands();

afterAll(() => {
  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
  rmSync(configHome, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(configHome, "woopcode"), { recursive: true, force: true });
  resetSessionStoreForTests();
});

/**
 * A controller stub over a real session store: the commands are the subject
 * here, not the controller, but what they do has to actually reach disk for
 * "the old session is still there" to mean anything.
 */
function createController(options: { busy?: boolean } = {}) {
  let current: any = null;

  return {
    busy: options.busy ?? false,
    isBusy() {
      return this.busy;
    },
    currentSession() {
      return current;
    },
    messageCount() {
      return current?.messages.length ?? 0;
    },
    async adopt(record: any) {
      current = record;
      return record;
    },
    async seed(messages: any[]) {
      const session = await createSession();
      current = await saveSession({ ...session, messages });
      return current;
    },
    async newSession() {
      if (this.busy) return null;
      current = await createSession();
      return current;
    },
    async switchSession(ref: string) {
      if (this.busy) return null;
      const sessions = await listSessions();
      const { resolveSessionRef } = await import("../../../config/sessions");
      const resolution = resolveSessionRef(ref, sessions);
      if (resolution.status === "ambiguous") {
        throw new Error(
          `"${ref}" matches ${resolution.matches.length} sessions. Use the id, or /sessions to list them.`,
        );
      }
      if (resolution.status === "none") return null;
      current = await loadSession(resolution.session.id, resolution.session.slug);
      return current;
    },
    async branchSession(name?: string) {
      if (this.busy || !current) return null;
      const { forkSession } = await import("../../../config/sessions");
      current = await forkSession(current.id, { name: name ?? null });
      return current;
    },
    async renameSession(name: string) {
      if (this.busy || !current) return null;
      current = await saveSession({ ...current, name: name.trim() || null });
      return current;
    },
  };
}

function createContext(controller: unknown): SlashCommandContext {
  return {
    controller: controller as any,
    onExit: async () => {},
    onOutput: () => {},
  };
}

async function run(name: string, controller: unknown, args: string[] = []) {
  return registry.get(name)!.execute(createContext(controller), args);
}

describe("/new", () => {
  test("keeps the previous conversation instead of deleting it", async () => {
    // The whole point of the change: /new used to call saveConversation([]),
    // and the documentation said outright that there was no undo.
    const controller = createController();
    const previous = await controller.seed([{ role: "user", content: "old work" }]);

    await run("new", controller);

    expect(await loadSession(previous.id)).not.toBeNull();
  });

  test("names the way back to what was left", async () => {
    const controller = createController();
    const previous = await controller.seed([{ role: "user", content: "old work" }]);

    const output = await run("new", controller);

    expect(output).toContain(previous.id.slice(0, 8));
  });

  test("says nothing about resuming when there was nothing to keep", async () => {
    const controller = createController();

    expect(await run("new", controller)).toBe("Started a new session");
  });

  test("refuses while a turn is running", async () => {
    const controller = createController({ busy: true });

    expect(await run("new", controller)).toContain("Cannot start a new session");
  });
});

describe("/resume", () => {
  test("switches to a session named by id prefix", async () => {
    const controller = createController();
    const target = await controller.seed([{ role: "user", content: "earlier" }]);
    await controller.newSession();

    const output = await run("resume", controller, [target.id.slice(0, 8)]);

    expect(output).toContain("Resumed");
    expect(controller.currentSession().id).toBe(target.id);
  });

  test("resumes by the name /rename gave it", async () => {
    const controller = createController();
    await controller.seed([{ role: "user", content: "earlier" }]);
    await run("rename", controller, ["auth-work"]);
    const named = controller.currentSession();
    await controller.newSession();

    await run("resume", controller, ["auth-work"]);

    expect(controller.currentSession().id).toBe(named.id);
  });

  test("an unknown reference is reported, not silently ignored", async () => {
    const controller = createController();

    const output = await run("resume", controller, ["no-such-session"]);

    expect(output).toContain("No session found");
  });

  test("refuses while a turn is running", async () => {
    const controller = createController({ busy: true });

    expect(await run("resume", controller, ["anything"])).toContain(
      "Cannot switch sessions",
    );
  });
});

describe("migrated history in a real session", () => {
  async function importLegacy() {
    const { migrateLegacyConversation, resetSessionStoreForTests: reset } = await import(
      "../../../config/sessions"
    );
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const configDir = join(configHome, "woopcode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "conversation.json"),
      JSON.stringify([{ role: "user", content: "legacy work" }]),
    );
    reset();
    return (await migrateLegacyConversation())!;
  }

  test("resuming it without working in it leaves it where it is", async () => {
    // Opening a conversation to read it must not move it. Only a turn does.
    const { AgentController } = await import("../../../commands/agentController");
    const imported = await importLegacy();

    const controller = new AgentController("test", "key", {});
    await controller.initialize({ sessionRef: imported.id });
    await controller.dispose();

    const { listSessions: list } = await import("../../../config/sessions");
    const row = (await list({ scope: "all" })).find((s) => s.id === imported.id);
    expect(row!.slug).toBe("legacy");
    expect(controller.currentSession()!.cwd).toBeNull();
  });
});

describe("--fork-session", () => {
  test("branches a session from another project instead of writing into it", async () => {
    // Two defects met here: forkSession looked only in the current project, and
    // the controller fell back to `fork() ?? original` when it came up empty —
    // so the flag that exists to protect the original wrote straight into it.
    const { AgentController } = await import("../../../commands/agentController");
    const { mkdirSync } = await import("node:fs");

    const elsewhere = mkdtempSync(join(tmpdir(), `woopcode-fork-${crypto.randomUUID()}-`));
    mkdirSync(join(elsewhere, ".git"), { recursive: true });
    const session = await createSession({ cwd: elsewhere });
    const original = await saveSession({
      ...session,
      messages: [{ role: "user", content: "from another project" }],
    });

    const controller = new AgentController("test", "key", {});
    await controller.initialize({ sessionRef: original.id, fork: true });

    const current = controller.currentSession()!;
    expect(current.id).not.toBe(original.id);
    expect(current.forkedFrom).toBe(original.id);
    expect(current.messages).toHaveLength(1);

    rmSync(elsewhere, { recursive: true, force: true });
  });

  test("a reference that names nothing fails rather than starting somewhere else", async () => {
    const { AgentController } = await import("../../../commands/agentController");
    const controller = new AgentController("test", "key", {});

    await expect(
      controller.initialize({ sessionRef: "no-such-session", fork: true }),
    ).rejects.toThrow(/No session found/);
  });
});

describe("/rename", () => {
  test("requires a name", async () => {
    expect(await run("rename", createController(), [])).toBe("Usage: /rename <name>");
  });

  test("reports when there is nothing saved yet", async () => {
    const output = await run("rename", createController(), ["anything"]);

    expect(output).toContain("run a turn first");
  });

  test("sets the resume handle", async () => {
    const controller = createController();
    await controller.seed([{ role: "user", content: "work" }]);

    expect(await run("rename", controller, ["auth-work"])).toBe("Renamed to auth-work");
  });
});

describe("/branch", () => {
  test("leaves the original session in place", async () => {
    const controller = createController();
    const original = await controller.seed([{ role: "user", content: "one way" }]);

    await run("branch", controller, ["other-way"]);

    expect(controller.currentSession().id).not.toBe(original.id);
    expect(await loadSession(original.id)).not.toBeNull();
  });

  test("carries the conversation into the copy", async () => {
    const controller = createController();
    await controller.seed([{ role: "user", content: "one way" }]);

    await run("branch", controller, ["other-way"]);

    expect(controller.currentSession().messages).toHaveLength(1);
    expect(controller.currentSession().forkedFrom).not.toBeNull();
  });

  test("reports when there is nothing to branch", async () => {
    expect(await run("branch", createController(), [])).toContain("run a turn first");
  });
});

describe("/sessions", () => {
  test("reports an empty project plainly", async () => {
    expect(await run("sessions", createController())).toContain("No saved sessions");
  });

  test("lists what is stored, marking the active one", async () => {
    const controller = createController();
    const session = await controller.seed([{ role: "user", content: "work" }]);

    const output = await run("sessions", controller);

    expect(output).toContain(session.id.slice(0, 8));
    expect(output).toContain("●");
  });
});
