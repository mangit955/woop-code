import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Config reads and writes go through a temp directory so a corrupt-file test
// can never touch the developer's real ~/.config/woopcode.
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const configHome = mkdtempSync(join(tmpdir(), "woopcode-config-"));
process.env.XDG_CONFIG_HOME = configHome;

const {
  MAX_PERSISTED_MESSAGES,
  getConfig,
  normalizeConfig,
  prepareConversationForDisk,
  saveConfig,
  MAX_PERSISTED_RECORDS,
} = await import("../../../config/config");

const {
  createSession,
  loadSession,
  saveSession,
  projectRoot,
  projectSlug,
  resetSessionStoreForTests,
} = await import("../../../config/sessions");

const configDir = join(configHome, "woopcode");
const providersPath = join(configDir, "providers.json");
const sessionsDir = join(configDir, "sessions");

/** Round-trips a conversation through a session, the way a turn does. */
async function storeConversation(messages: Parameters<typeof prepareConversationForDisk>[0]) {
  const session = await createSession();
  const saved = await saveSession({ ...session, messages });
  return (await loadSession(saved.id))!;
}

afterAll(() => {
  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
  rmSync(configHome, { recursive: true, force: true });
});

function corruptFiles(prefix: string) {
  return readdirSync(configDir).filter(
    (name) => name.startsWith(prefix) && name.includes(".corrupt-"),
  );
}

describe("normalizeConfig", () => {
  test("supplies a providers map whatever the input shape", () => {
    for (const input of [undefined, null, "nonsense", 42, ["a"], {}]) {
      const config = normalizeConfig(input);
      expect(config.providers).toEqual({});
      expect(config.defaultProvider).toBe("");
    }
  });

  test("keeps valid entries and drops malformed ones", () => {
    const config = normalizeConfig({
      defaultProvider: "google",
      selectedModel: "gemini-3.5-flash-lite",
      providers: {
        google: { type: "api", apiKey: "key" },
        broken: "not-an-object",
        openai: { apiKey: 42 },
      },
    });

    expect(config.defaultProvider).toBe("google");
    expect(config.selectedModel).toBe("gemini-3.5-flash-lite");
    expect(config.providers.google).toEqual({ type: "api", apiKey: "key" });
    expect(config.providers.broken).toBeUndefined();
    // A non-string key is dropped rather than trusted downstream.
    expect(config.providers.openai).toEqual({ type: "api" });
  });

  test("ignores a non-string defaultProvider instead of returning it", () => {
    expect(normalizeConfig({ defaultProvider: 7 }).defaultProvider).toBe("");
  });
});

describe("corrupt file recovery", () => {
  beforeEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test("a corrupt provider config is quarantined and defaults restored", async () => {
    await saveConfig({ defaultProvider: "google", providers: {} });
    writeFileSync(providersPath, '{"defaultProvider":"google","providers":{');

    const config = await getConfig();

    expect(config.providers.google).toBeDefined();
    expect(config.defaultProvider).toBe("google");
    expect(corruptFiles("providers.json")).toHaveLength(1);
  });

  test("an empty provider config does not crash", async () => {
    await saveConfig({ defaultProvider: "google", providers: {} });
    writeFileSync(providersPath, "");

    await expect(getConfig()).resolves.toBeDefined();
  });

  test("a missing provider entry reads back as absent, not a crash", async () => {
    await saveConfig({ defaultProvider: "google", providers: {} });

    const config = await getConfig();

    expect(config.providers.google?.apiKey).toBeUndefined();
  });

  test("a corrupt session is skipped rather than crashing the store", async () => {
    const stored = await storeConversation([{ role: "user", content: "hi" }]);
    const sessionPath = join(sessionsDir, projectSlug(projectRoot()), `${stored.id}.json`);
    writeFileSync(sessionPath, '[{"role":"user"');

    // Null, not a throw: one unreadable session must not make the picker
    // unopenable or stop a launch.
    await expect(loadSession(stored.id)).resolves.toBeNull();
  });

  test("malformed messages are dropped, valid ones kept", async () => {
    const stored = await storeConversation([{ role: "user", content: "hi" }]);
    const sessionPath = join(sessionsDir, projectSlug(projectRoot()), `${stored.id}.json`);
    const raw = JSON.parse(await Bun.file(sessionPath).text());
    raw.messages = [{ role: "user", content: "hi" }, null, "junk", { content: "no role" }];
    writeFileSync(sessionPath, JSON.stringify(raw));

    const loaded = await loadSession(stored.id);

    expect(loaded!.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("conversation persistence", () => {
  beforeEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    resetSessionStoreForTests();
  });

  test("does not persist tool calls or their results", async () => {
    const stored = await storeConversation([
      { role: "user", content: "hi" },
      {
        role: "assistant_tool_call",
        toolName: "read_file",
        toolCallId: "1",
        arguments: { path: "a.ts" },
      },
      { role: "tool", toolName: "read_file", toolCallId: "1", content: "x".repeat(5_000) },
      { role: "assistant", content: "done" },
    ]);

    expect(stored.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  test("keeps only the most recent messages", async () => {
    const messages = Array.from({ length: MAX_PERSISTED_MESSAGES + 40 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message ${index}`,
    }));

    const stored = await storeConversation(messages);

    expect(stored.messages).toHaveLength(MAX_PERSISTED_MESSAGES);
    expect(stored.messages.at(-1)).toEqual(messages.at(-1)!);
  });

  test("prepareConversationForDisk leaves a short conversation alone", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];

    expect(prepareConversationForDisk(messages)).toEqual(messages);
  });

  test("writes atomically, leaving no partial file behind", async () => {
    const stored = await storeConversation([{ role: "user", content: "hi" }]);
    const projectDir = join(sessionsDir, projectSlug(projectRoot()));

    expect(readdirSync(projectDir).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
    expect(stored.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("execution log persistence", () => {
  beforeEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    resetSessionStoreForTests();
  });

  test("records survive a restart", async () => {
    // Without this the log would survive a turn but not a restart, which is
    // the same forgetting one level up.
    const session = await createSession();
    const saved = await saveSession({
      ...session,
      executionLog: [
        { iteration: 1, tool: "read_file", subject: "a.ts", outcome: "12 lines" },
      ],
    });

    const reopened = await loadSession(saved.id);

    expect(reopened!.executionLog).toEqual([
      { iteration: 1, tool: "read_file", subject: "a.ts", outcome: "12 lines" },
    ]);
  });

  test("a fresh session starts with an empty log", async () => {
    const session = await createSession();
    expect(session.executionLog).toEqual([]);
  });

  test("the log is capped so a long-lived session cannot grow it forever", async () => {
    const many = Array.from({ length: MAX_PERSISTED_RECORDS + 50 }, (_, i) => ({
      iteration: i,
      tool: "read_file",
      subject: `f${i}.ts`,
      outcome: "1 line",
    }));
    const session = await createSession();
    const saved = await saveSession({ ...session, executionLog: many });

    expect(saved.executionLog).toHaveLength(MAX_PERSISTED_RECORDS);
    // The most recent survive: what was done last is what must not be redone.
    expect(saved.executionLog.at(-1)!.subject).toBe(`f${many.length - 1}.ts`);
  });

  test("entries that are not records are discarded", async () => {
    const session = await createSession();
    const saved = await saveSession({ ...session, messages: [{ role: "user", content: "x" }] });
    const sessionPath = join(sessionsDir, projectSlug(projectRoot()), `${saved.id}.json`);
    const raw = JSON.parse(await Bun.file(sessionPath).text());
    raw.executionLog = [null, 42, { tool: "read_file", outcome: "3 lines" }];
    writeFileSync(sessionPath, JSON.stringify(raw));

    expect((await loadSession(saved.id))!.executionLog).toHaveLength(1);
  });
});
