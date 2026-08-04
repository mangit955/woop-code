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
const { toolRegistery } = await import("../../../tools");

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
    expect((await getConfig()).providers.openai?.apiKey).toBeUndefined();
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

  /**
   * The provider is in providers.json — a config written by hand, or by a
   * build that knew a provider this one does not. Being configured is checked
   * before being runnable, so it has to be present to reach the registry gate
   * at all, which is the gate under test.
   */
  test("/provider refuses a configured provider the registry cannot run", async () => {
    await saveConfig({
      defaultProvider: "google",
      selectedModel: "gemini-3.5-flash-lite",
      providers: {
        google: { type: "api", apiKey: "google-key" },
        mistral: { type: "api", apiKey: "mistral-key" },
      },
    });
    const controller = createController();

    const output = await registry
      .get("provider")!
      .execute(createContext(controller), ["mistral"]);

    expect(output).toContain("Unknown provider");
    expect(controller.calls).toHaveLength(0);
    expect((await getConfig()).defaultProvider).toBe("google");
  });

  /**
   * The registry check runs before the key is verified, so this resolves
   * without touching the network. That ordering is the point: a refused
   * provider must not cost a round trip, and a test that reached a real API
   * would be slow and offline-fragile for no coverage.
   */
  test("/login refuses a provider the registry does not know", async () => {
    const controller = createController();

    const output = await registry
      .get("login")!
      .execute(createContext(controller), ["mistral", "sk-test"]);

    expect(output).toContain("Unknown provider");
    expect(controller.calls).toHaveLength(0);
  });
});

describe("status and model reporting", () => {
  beforeEach(async () => {
    await saveConfig({
      defaultProvider: "google",
      selectedModel: "gemini-3.5-flash-lite",
      providers: { google: { type: "api", apiKey: "google-key" } },
    });
  });

  function controllerOn(model: string) {
    return { isBusy: () => false, getModel: () => model, setProvider: () => true };
  }

  test("/status reports the real tool count", async () => {
    const output = await registry
      .get("status")!
      .execute(createContext(controllerOn("gemini-3.6-pro")), []);

    expect(output).toContain(`Tools: ${toolRegistery.length} registered`);
    expect(output).not.toContain("Tools: 9 registered");
  });

  test("/status reports the model the session is actually using", async () => {
    const output = await registry
      .get("status")!
      .execute(createContext(controllerOn("gemini-3.6-pro")), []);

    expect(output).toContain("gemini-3.6-pro");
    expect(output).not.toContain("Model: gemini-3.5-flash-lite");
  });

  test("/status falls back to the saved selection without a controller", async () => {
    const output = await registry
      .get("status")!
      .execute(createContext({ isBusy: () => false }), []);

    expect(output).toContain("gemini-3.5-flash-lite");
  });

  test("/status names the provider from the registry", async () => {
    const output = await registry
      .get("status")!
      .execute(createContext(controllerOn("gemini-3.6-pro")), []);

    expect(output).toContain("Provider: Google Gemini");
  });

  test("/models reports the active model, not a hard-coded one", async () => {
    const output = await registry
      .get("models")!
      .execute(createContext(controllerOn("gemini-3.6-flash")), []);

    expect(output).toContain("Current Model: Gemini 3.6 Flash (gemini-3.6-flash)");
  });

  test("/models marks the active model in the list", async () => {
    const output = await registry
      .get("models")!
      .execute(createContext(controllerOn("gemini-3.6-flash")), []);

    const marked = output
      .split("\n")
      .filter((line) => line.includes("(current)"));

    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("gemini-3.6-flash");
  });
});
