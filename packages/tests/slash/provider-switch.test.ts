import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SlashCommandContext } from "../../../commands/slash/types";

// These commands read and write the real providers.json. Point the config
// directory at a temp dir instead of mocking the config module, which would
// leak into every other test file in the run.
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const configHome = mkdtempSync(join(tmpdir(), "woopcode-slash-"));
process.env.XDG_CONFIG_HOME = configHome;

const { registry } = await import("../../../commands/slash/registry");
const { registerCommands } = await import("../../../commands/slash/commands");
const { getConfig, saveConfig } = await import("../../../config/config");

registerCommands();

afterAll(() => {
  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
  rmSync(configHome, { recursive: true, force: true });
});

function createContext(controller: unknown): SlashCommandContext {
  return {
    controller: controller as any,
    onExit: async () => {},
    onOutput: () => {},
  };
}

function createController() {
  const calls: Array<[string, string, string | undefined]> = [];

  return {
    busy: false,
    calls,
    isBusy() {
      return this.busy;
    },
    setProvider(provider: string, apiKey: string, model?: string) {
      if (this.busy) return false;
      calls.push([provider, apiKey, model]);
      return true;
    },
  };
}

describe("provider slash commands update the running session", () => {
  beforeEach(async () => {
    await saveConfig({
      defaultProvider: "openai",
      selectedModel: "gpt-5",
      providers: {
        google: { type: "api", apiKey: "google-key" },
        openai: { type: "api", apiKey: "openai-key" },
      },
    });
  });

  test("/provider pushes the new provider and key into the controller", async () => {
    const controller = createController();

    const output = await registry
      .get("provider")!
      .execute(createContext(controller), ["google"]);

    expect(controller.calls[0]?.[0]).toBe("google");
    expect(controller.calls[0]?.[1]).toBe("google-key");
    expect((await getConfig()).defaultProvider).toBe("google");
    expect(output).toContain("Switched to: google");
  });

  test("/provider moves off a model that belongs to another provider", async () => {
    const controller = createController();

    await registry.get("provider")!.execute(createContext(controller), ["google"]);

    const model = controller.calls[0]?.[2];
    expect(model).toStartWith("gemini-");
    expect((await getConfig()).selectedModel).toBe(model);
  });

  test("/provider refuses to swap credentials mid-turn", async () => {
    const controller = createController();
    controller.busy = true;

    const output = await registry
      .get("provider")!
      .execute(createContext(controller), ["google"]);

    expect(controller.calls).toHaveLength(0);
    expect((await getConfig()).defaultProvider).toBe("openai");
    expect(output).toContain("Cannot switch provider while the agent is running");
  });

  test("/logout hands the session the fallback provider's key", async () => {
    const controller = createController();

    await registry.get("logout")!.execute(createContext(controller), ["openai"]);

    expect(controller.calls[0]?.[0]).toBe("google");
    expect(controller.calls[0]?.[1]).toBe("google-key");
    expect((await getConfig()).providers.openai.apiKey).toBeUndefined();
  });

  test("/logout clears the session credentials when nothing is left", async () => {
    await saveConfig({
      defaultProvider: "openai",
      selectedModel: "gpt-5",
      providers: {
        google: { type: "api", apiKey: "" },
        openai: { type: "api", apiKey: "openai-key" },
      },
    });
    const controller = createController();

    await registry.get("logout")!.execute(createContext(controller), ["openai"]);

    expect(controller.calls[0]?.[0]).toBe("");
    expect(controller.calls[0]?.[1]).toBe("");
    expect((await getConfig()).defaultProvider).toBe("");
  });

  test("/provider refuses a provider with no runtime client", async () => {
    await saveConfig({
      defaultProvider: "google",
      selectedModel: "gemini-3.5-flash-lite",
      providers: {
        google: { type: "api", apiKey: "google-key" },
        openai: { type: "api", apiKey: "openai-key" },
      },
    });
    const controller = createController();

    const output = await registry
      .get("provider")!
      .execute(createContext(controller), ["openai"]);

    expect(output).toContain("not supported yet");
    expect(controller.calls).toHaveLength(0);
    expect((await getConfig()).defaultProvider).toBe("google");
  });

  test("/login refuses a provider with no runtime client", async () => {
    const controller = createController();

    const output = await registry
      .get("login")!
      .execute(createContext(controller), ["openai", "sk-test"]);

    expect(output).toContain("not supported yet");
    expect(controller.calls).toHaveLength(0);
  });
});
