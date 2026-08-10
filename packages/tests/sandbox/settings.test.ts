import { test, expect, describe } from "bun:test";
import {
  forwardedEnv,
  isForwardableName,
  parseNetworkMode,
  resolveSandboxSettings,
  DEFAULT_SANDBOX_TIMEOUT_MS,
} from "../../../runtime/sandbox/settings";
import { DEFAULT_MAX_FILE_BYTES } from "../../../runtime/sandbox/transmittable";
import { DEFAULT_TIMEOUT_SECONDS } from "../../../tools/terminal";

/**
 * Sandbox configuration, all of it pure.
 *
 * The environment allowlist is the half of credential isolation that the
 * transmittable set does not cover: files are filtered by name, and variables
 * are filtered here. Both have to hold for "the sandbox never sees your keys"
 * to be true.
 */

describe("environment forwarding", () => {
  test("nothing is forwarded by default", () => {
    const { envs } = forwardedEnv(undefined, { GITHUB_TOKEN: "ghp_x" });
    expect(envs).toEqual({});
  });

  test("a named variable is forwarded with its value", () => {
    const { envs } = forwardedEnv("GITHUB_TOKEN, NPM_TOKEN", {
      GITHUB_TOKEN: "ghp_x",
      NPM_TOKEN: "npm_y",
      OTHER: "no",
    });

    expect(envs).toEqual({ GITHUB_TOKEN: "ghp_x", NPM_TOKEN: "npm_y" });
  });

  test("agent and provider credentials are refused even when named explicitly", () => {
    // The allowlist exists so a build can be given a registry token. It is not
    // a way to hand a sandbox the keys to the agent itself — a model that talks
    // its user into naming one here should still get nothing.
    const { envs, refused } = forwardedEnv(
      "WOOPCODE_API_KEY,E2B_API_KEY,ANTHROPIC_API_KEY,OPENAI_API_KEY,GEMINI_API_KEY,GITHUB_TOKEN",
      {
        WOOPCODE_API_KEY: "sk-agent",
        E2B_API_KEY: "e2b-key",
        ANTHROPIC_API_KEY: "sk-ant",
        OPENAI_API_KEY: "sk-oai",
        GEMINI_API_KEY: "gm",
        GITHUB_TOKEN: "ghp_x",
      },
    );

    expect(envs).toEqual({ GITHUB_TOKEN: "ghp_x" });
    expect(refused).toHaveLength(5);
    expect(Object.values(envs).join(" ")).not.toContain("sk-");
  });

  test("the refusal is by shape, not by exact name", () => {
    // A renamed key is still a key: matching the whole name exactly would be
    // defeated by MY_ANTHROPIC_API_KEY_BACKUP.
    expect(isForwardableName("MY_ANTHROPIC_KEY_BACKUP")).toBe(false);
    expect(isForwardableName("openai_api_key")).toBe(false);
    expect(isForwardableName("WOOPCODE_API_KEY_OLD")).toBe(false);
    expect(isForwardableName("GITHUB_TOKEN")).toBe(true);
    expect(isForwardableName("CI")).toBe(true);
  });

  test("a named variable that is not set is simply absent", () => {
    const { envs, refused } = forwardedEnv("NOT_SET_ANYWHERE", {});
    expect(envs).toEqual({});
    expect(refused).toEqual([]);
  });
});

describe("network mode", () => {
  test("full is the default and anything unreadable lands there", () => {
    expect(parseNetworkMode(undefined)).toBe("full");
    expect(parseNetworkMode("")).toBe("full");
    expect(parseNetworkMode("nonsense")).toBe("full");
    expect(parseNetworkMode("none")).toBe("none");
  });
});

describe("resolved settings", () => {
  test("defaults", () => {
    const { settings } = resolveSandboxSettings({});

    expect(settings.template).toBeUndefined();
    expect(settings.timeoutMs).toBe(DEFAULT_SANDBOX_TIMEOUT_MS);
    expect(settings.maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(settings.network).toBe("full");
    expect(settings.envs).toEqual({});
    expect(settings.setupCommand).toBeUndefined();
  });

  test("the sandbox outlives the longest command it could be asked to run", () => {
    // E2B's own default sandbox lifetime is 300_000ms and run_terminal's
    // default timeout is 300 seconds — identical, so a command using its whole
    // budget would race the reaper and the winner would be luck.
    const { settings } = resolveSandboxSettings({});
    expect(settings.timeoutMs).toBeGreaterThan(DEFAULT_TIMEOUT_SECONDS * 1000);
  });

  test("a command-line network mode wins over the environment", () => {
    const { settings } = resolveSandboxSettings(
      { WOOPCODE_SANDBOX_NETWORK: "full" },
      { network: "none" },
    );
    expect(settings.network).toBe("none");
  });

  test("unusable numbers fall back rather than becoming NaN", () => {
    const { settings } = resolveSandboxSettings({
      WOOPCODE_SANDBOX_TIMEOUT_MS: "soon",
      WOOPCODE_SANDBOX_MAX_FILE_BYTES: "-5",
    });

    expect(settings.timeoutMs).toBe(DEFAULT_SANDBOX_TIMEOUT_MS);
    expect(settings.maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
  });

  test("template and setup command are read when set", () => {
    const { settings } = resolveSandboxSettings({
      WOOPCODE_SANDBOX_TEMPLATE: "my-template",
      WOOPCODE_SANDBOX_SETUP: "make bootstrap",
    });

    expect(settings.template).toBe("my-template");
    expect(settings.setupCommand).toBe("make bootstrap");
  });

  test("refused variables are reported to the caller", () => {
    const { refusedEnv } = resolveSandboxSettings({
      WOOPCODE_SANDBOX_ENV: "E2B_API_KEY",
      E2B_API_KEY: "secret",
    });

    expect(refusedEnv).toEqual(["E2B_API_KEY"]);
  });
});
