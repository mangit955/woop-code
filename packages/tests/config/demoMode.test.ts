import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Redirected before the modules under test are imported, and for the whole
// file rather than per test: config paths are resolved at call time from this
// variable, and restoring it in an afterEach would point the rest of the file
// at the developer's real ~/.config/woopcode.
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const previousDemoUrl = process.env.WOOPCODE_DEMO_URL;
const configHome = mkdtempSync(join(tmpdir(), `woopcode-demo-${crypto.randomUUID()}-`));
process.env.XDG_CONFIG_HOME = configHome;

const { getConfig, saveConfig, normalizeConfig, apiProviderEntry } = await import(
  "../../../config/config"
);
const {
  DEMO_EXHAUSTED_MARKER,
  demoEndpoint,
  demoExhaustionMessage,
  demoProviderEntry,
  getInstallId,
  isDemoEntry,
  isDemoExpired,
  requestDemoSession,
} = await import("../../../config/demoAccount");
const { resolveCredentials } = await import("../../../onboarding");

const configDir = join(configHome, "woopcode");
const providersPath = join(configDir, "providers.json");

const HOUR = 60 * 60 * 1000;

afterAll(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  if (previousDemoUrl === undefined) delete process.env.WOOPCODE_DEMO_URL;
  else process.env.WOOPCODE_DEMO_URL = previousDemoUrl;
  rmSync(configHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await Bun.write(
    providersPath,
    JSON.stringify({ defaultProvider: "", providers: {} }, null, 2),
  );
});

describe("the default endpoint", () => {
  // The default is compiled into every installed copy and cannot be corrected
  // for anyone who does not upgrade. It shipped once pointing at
  // demo.woopcode.dev, a domain that was never registered, so every install
  // reported the demo unreachable and fell through to the key prompt.
  test("is not the unregistered host it used to be", () => {
    expect(demoEndpoint({})).not.toContain("demo.woopcode.dev");
  });

  test("is an absolute https URL with no trailing slash", () => {
    const endpoint = demoEndpoint({});
    expect(endpoint).toStartWith("https://");
    expect(endpoint).not.toEndWith("/");
  });

  test("an override wins and is normalised", () => {
    expect(demoEndpoint({ WOOPCODE_DEMO_URL: "http://localhost:8787///" })).toBe(
      "http://localhost:8787",
    );
  });

  test("a blank override falls back rather than producing an empty URL", () => {
    expect(demoEndpoint({ WOOPCODE_DEMO_URL: "   " })).toBe(demoEndpoint({}));
  });
});

describe("a demo entry survives being stored", () => {
  // The regression this file exists for. normalizeConfig rebuilds every
  // provider entry field by field, so a field it does not name is dropped on
  // the next read — silently, and with the worst possible result: the demo
  // token stays but the proxy URL it is only valid against does not, so the
  // next turn sends a Woopcode token to Google as if it were a Google key.
  test("baseUrl and demoExpiresAt round-trip through disk", async () => {
    const config = await getConfig();
    config.defaultProvider = "google";
    config.providers.google = demoProviderEntry({
      token: "demo-token",
      expiresAt: Date.now() + HOUR,
    });
    await saveConfig(config);

    const reloaded = await getConfig();

    expect(reloaded.providers.google?.apiKey).toBe("demo-token");
    expect(reloaded.providers.google?.baseUrl).toBe(demoEndpoint());
    expect(reloaded.providers.google?.type).toBe("demo");
    expect(typeof reloaded.providers.google?.demoExpiresAt).toBe("number");
  });

  test("a non-numeric expiry is dropped rather than carried through", () => {
    const normalized = normalizeConfig({
      defaultProvider: "google",
      providers: { google: { type: "demo", apiKey: "t", demoExpiresAt: "soon" } },
    });

    expect(normalized.providers.google).not.toHaveProperty("demoExpiresAt");
  });
});

describe("leaving demo mode", () => {
  // Every path that stores a user's own key builds the entry with
  // apiProviderEntry. Spreading over the previous entry instead kept the
  // demo's type, proxy URL and expiry alive underneath the new key, which sent
  // a real Google credential to Woopcode's proxy and expired it on the demo's
  // schedule.
  test("apiProviderEntry carries nothing over from a demo entry", () => {
    const demo = demoProviderEntry({ token: "demo-token", expiresAt: Date.now() + HOUR });
    const upgraded = { ...demo, ...apiProviderEntry("real-key") };

    // The spread above is what a caller must NOT do; the assertion is that
    // apiProviderEntry's own result is clean.
    expect(upgraded.baseUrl).toBeDefined();
    expect(apiProviderEntry("real-key")).toEqual({ type: "api", apiKey: "real-key" });
    expect(apiProviderEntry("real-key")).not.toHaveProperty("baseUrl");
    expect(apiProviderEntry("real-key")).not.toHaveProperty("demoExpiresAt");
  });
});

describe("expiry", () => {
  test("a live demo entry is not expired", () => {
    expect(isDemoExpired({ type: "demo", demoExpiresAt: Date.now() + HOUR })).toBe(false);
  });

  test("a past deadline is expired", () => {
    expect(isDemoExpired({ type: "demo", demoExpiresAt: Date.now() - 1 })).toBe(true);
  });

  test("a demo entry with no deadline is expired, not immortal", () => {
    expect(isDemoExpired({ type: "demo", apiKey: "t" })).toBe(true);
  });

  // A user's own key has no deadline either. Judging it by the same rule would
  // lock every ordinary user out of credentials they supplied themselves.
  test("a real key is never expired", () => {
    expect(isDemoExpired({ type: "api", apiKey: "real" })).toBe(false);
    expect(isDemoEntry({ type: "api", apiKey: "real" })).toBe(false);
  });
});

describe("resolveCredentials", () => {
  async function store(entry: Record<string, unknown>) {
    await Bun.write(
      providersPath,
      JSON.stringify({ defaultProvider: "google", providers: { google: entry } }, null, 2),
    );
  }

  test("a live demo session resolves with its base URL", async () => {
    await store({
      type: "demo",
      apiKey: "demo-token",
      baseUrl: "https://demo.example",
      demoExpiresAt: Date.now() + HOUR,
    });

    expect(await resolveCredentials()).toEqual({
      provider: "google",
      apiKey: "demo-token",
      baseUrl: "https://demo.example",
    });
  });

  // Not "returns the entry and lets the turn 403": that puts the failure in
  // front of a user with no wizard left to fall back into.
  test("an expired demo session counts as unconfigured", async () => {
    await store({
      type: "demo",
      apiKey: "demo-token",
      baseUrl: "https://demo.example",
      demoExpiresAt: Date.now() - 1,
    });

    expect(await resolveCredentials()).toBeNull();
  });

  test("a real key resolves with no base URL at all", async () => {
    await store({ type: "api", apiKey: "real-key" });

    const resolved = await resolveCredentials();
    expect(resolved).toEqual({ provider: "google", apiKey: "real-key" });
    expect(resolved).not.toHaveProperty("baseUrl");
  });
});

describe("requesting a session from the proxy", () => {
  /** A real server on a real port, so the request is not imagined. */
  function serve(handler: (request: Request) => Response | Promise<Response>) {
    const server = Bun.serve({ port: 0, fetch: handler });
    process.env.WOOPCODE_DEMO_URL = `http://localhost:${server.port}`;
    return server;
  }

  test("a granted session is returned and the install id is sent", async () => {
    let body: unknown;
    let path = "";
    const server = serve(async (request) => {
      path = new URL(request.url).pathname;
      body = await request.json();
      return Response.json({
        token: "issued-token",
        expiresAt: 4102444800000,
        dailyLimit: 50,
      });
    });

    try {
      const session = await requestDemoSession();
      expect(session).toEqual({
        token: "issued-token",
        expiresAt: 4102444800000,
        dailyLimit: 50,
      });
      expect(path).toBe("/v1/session");
      expect((body as { installId: string }).installId).toBe(await getInstallId());
    } finally {
      server.stop(true);
    }
  });

  test("the install id is stable across calls", async () => {
    const first = await getInstallId();
    expect(await getInstallId()).toBe(first);
    expect(first.length).toBeGreaterThan(0);
  });

  // Absent, not forever. A token with no deadline would outlive whatever the
  // server granted and fail on some later turn instead of here.
  test("a session with no expiry is treated as already expired", async () => {
    const server = serve(() => Response.json({ token: "t" }));

    try {
      const session = await requestDemoSession();
      expect(session.expiresAt).toBe(0);
      expect(isDemoExpired(demoProviderEntry(session))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("the kill switch reports the demo as unavailable", async () => {
    const server = serve(() => new Response("off", { status: 503 }));

    try {
      await expect(requestDemoSession()).rejects.toThrow(/temporarily unavailable/i);
    } finally {
      server.stop(true);
    }
  });

  test("every failure still points at the other way in", async () => {
    const server = serve(() => new Response("no", { status: 429 }));

    try {
      await expect(requestDemoSession()).rejects.toThrow(/your own API key/i);
    } finally {
      server.stop(true);
    }
  });

  // Otherwise the wizard sits on a spinner with no key handler, on the first
  // screen a new user ever sees, with only Ctrl+C out.
  test("a proxy that never answers gives up instead of hanging", async () => {
    const server = serve(() => new Promise<Response>(() => {}));

    try {
      // A short deadline rather than the real one: this proves the mechanism
      // fires, and waiting out the production value would add ten seconds to
      // every run of the whole suite for a single assertion.
      await expect(requestDemoSession(undefined, 50)).rejects.toThrow(
        /did not respond in time/i,
      );
    } finally {
      server.stop(true);
    }
  });

  test("a caller's own cancellation is still honoured", async () => {
    const server = serve(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    try {
      await expect(requestDemoSession(controller.signal)).rejects.toThrow(
        /demo service/i,
      );
    } finally {
      server.stop(true);
    }
  });

  test("a response that is not a session is refused", async () => {
    const server = serve(() => Response.json({ nope: true }));

    try {
      await expect(requestDemoSession()).rejects.toThrow(/unusable response/i);
    } finally {
      server.stop(true);
    }
  });
});

// The proxy's two refusals are chosen to land on opposite sides of a rule that
// already exists in runtime/retry.ts, and nothing in that file mentions the
// demo. If someone moves 403 into the retryable set, exhaustion starts costing
// three round trips to reach the same answer, and load shedding stops working
// if 429 leaves it. This is the test that notices.
describe("the proxy's status codes match what retry already does", () => {
  test("403 — allowance spent — is fatal, so it is not retried", async () => {
    const { isRetryableError } = await import("../../../runtime/retry");
    expect(isRetryableError({ status: 403 })).toBe(false);
  });

  test("429 — proxy busy — is retried, which is how load shedding works", async () => {
    const { isRetryableError } = await import("../../../runtime/retry");
    expect(isRetryableError({ status: 429 })).toBe(true);
  });
});

describe("exhaustion is explained, not passed through", () => {
  const demoEntry = { baseUrl: "https://demo.example" };

  test("the marker becomes an instruction naming /login", () => {
    const message = demoExhaustionMessage(
      new Error(`403 Forbidden {"error":"${DEMO_EXHAUSTED_MARKER}"}`),
      demoEntry,
    );

    expect(message).toContain("Demo limit reached");
    expect(message).toContain("/login");
  });

  // Anything unrecognised is left alone: a mapping that swallowed other errors
  // would replace a real bug with a wrong explanation.
  test("an unrelated failure is left untouched", () => {
    expect(demoExhaustionMessage(new Error("socket hang up"), demoEntry)).toBeNull();
  });

  test("the same marker on a real key is not rewritten", () => {
    expect(
      demoExhaustionMessage(new Error(DEMO_EXHAUSTED_MARKER), { baseUrl: undefined }),
    ).toBeNull();
  });
});
