import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Config reads and writes go through a temp directory so a corrupt-file test
// can never touch the developer's real ~/.config/woopcode.
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const configHome = mkdtempSync(join(tmpdir(), "woopcode-config-"));
process.env.XDG_CONFIG_HOME = configHome;

const { getConfig, getConversation, normalizeConfig, saveConfig } = await import(
  "../../../config/config"
);

const configDir = join(configHome, "woopcode");
const providersPath = join(configDir, "providers.json");
const conversationPath = join(configDir, "conversation.json");

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

  test("a corrupt conversation is quarantined and the transcript starts fresh", async () => {
    await getConfig(); // ensures the config dir exists
    writeFileSync(conversationPath, '[{"role":"user"');

    await expect(getConversation()).resolves.toEqual([]);
    expect(corruptFiles("conversation.json")).toHaveLength(1);
  });

  test("a conversation that is not a list starts fresh", async () => {
    await getConfig();
    writeFileSync(conversationPath, '{"role":"user"}');

    await expect(getConversation()).resolves.toEqual([]);
  });

  test("malformed messages are dropped, valid ones kept", async () => {
    await getConfig();
    writeFileSync(
      conversationPath,
      JSON.stringify([{ role: "user", content: "hi" }, null, "junk", { content: "no role" }]),
    );

    await expect(getConversation()).resolves.toEqual([
      { role: "user", content: "hi" },
    ]);
  });
});
