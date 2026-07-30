import { describe, expect, test } from "bun:test";
import { applyModelSelection, type ModelSelectionDeps } from "./model-selection";
import type { ProvidersConfig } from "../../config/config";

function scenario(overrides: Partial<ModelSelectionDeps> = {}) {
  const calls: string[] = [];
  const saved: ProvidersConfig[] = [];
  const committed: string[] = [];
  let currentModel = "gemini-2.0-flash";

  const deps: ModelSelectionDeps = {
    modelId: "gemini-2.5-flash",
    isBusy: () => false,
    setModel: (id) => {
      calls.push("setModel");
      currentModel = id;
      return true;
    },
    loadConfig: async () => {
      calls.push("loadConfig");
      return {
        defaultProvider: "google",
        selectedModel: "gemini-2.0-flash",
        providers: { google: { apiKey: "key" } },
      };
    },
    saveConfig: async (config) => {
      calls.push("saveConfig");
      saved.push(config);
    },
    commit: (id) => {
      calls.push("commit");
      committed.push(id);
    },
    ...overrides,
  };

  return {
    deps,
    calls,
    saved,
    committed,
    activeModel: () => currentModel,
  };
}

describe("model selection", () => {
  test("persists before it changes the running session", async () => {
    const context = scenario();

    const outcome = await applyModelSelection(context.deps);

    expect(outcome).toEqual({ status: "applied" });
    // The order is the fix: a write that fails must not be able to leave the
    // session on a model the config file does not record.
    expect(context.calls).toEqual(["loadConfig", "saveConfig", "setModel", "commit"]);
    expect(context.saved[0]?.selectedModel).toBe("gemini-2.5-flash");
    expect(context.activeModel()).toBe("gemini-2.5-flash");
    expect(context.committed).toEqual(["gemini-2.5-flash"]);
  });

  test("changes nothing when the config write fails", async () => {
    const context = scenario({
      saveConfig: async () => {
        throw new Error("EACCES: permission denied");
      },
    });

    const outcome = await applyModelSelection(context.deps);

    expect(outcome.status).toBe("failed");
    expect(outcome).toHaveProperty("message", expect.stringContaining("EACCES"));
    // The reported bug: the session used to switch anyway, and silently.
    expect(context.calls).not.toContain("setModel");
    expect(context.calls).not.toContain("commit");
    expect(context.activeModel()).toBe("gemini-2.0-flash");
  });

  test("changes nothing when the config cannot be read", async () => {
    const context = scenario();
    context.deps.loadConfig = async () => {
      context.calls.push("loadConfig");
      throw new Error("unreadable config");
    };

    const outcome = await applyModelSelection(context.deps);

    expect(outcome.status).toBe("failed");
    expect(context.calls).toEqual(["loadConfig"]);
    expect(context.activeModel()).toBe("gemini-2.0-flash");
  });

  test("reports a non-Error failure without crashing on it", async () => {
    const context = scenario({
      saveConfig: async () => {
        throw "disk full";
      },
    });

    const outcome = await applyModelSelection(context.deps);

    expect(outcome).toHaveProperty("message", expect.stringContaining("disk full"));
  });

  test("refuses mid-turn without writing anything", async () => {
    const context = scenario({ isBusy: () => true });

    const outcome = await applyModelSelection(context.deps);

    expect(outcome.status).toBe("refused");
    // Refusing before the write is what keeps the file and the session in step.
    expect(context.calls).toEqual([]);
    expect(context.activeModel()).toBe("gemini-2.0-flash");
  });

  test("keeps the picker open when the save lands but the swap does not", async () => {
    const context = scenario({ setModel: () => false });

    const outcome = await applyModelSelection(context.deps);

    expect(outcome.status).toBe("failed");
    expect(outcome).toHaveProperty("message", expect.stringContaining("next session"));
    // Not committed: showing it as active would misreport the running model.
    expect(context.committed).toEqual([]);
  });
});
