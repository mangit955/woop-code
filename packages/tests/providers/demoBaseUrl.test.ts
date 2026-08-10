import { describe, test, expect, afterEach } from "bun:test";
import { createProviderClient, geminiClient } from "../../../providers/client";
import type { Message } from "../../../config/types";

/**
 * Demo mode is one line: the Gemini client is handed a base URL and the SDK
 * sends everything to it instead of to Google. Every other part of the feature
 * — the token, the config field, the wizard — is worthless if that line is
 * wrong, and wrong in the direction that matters silently: a request that
 * still goes to Google carries a Woopcode demo token as if it were a Google
 * key, and comes back as an authentication error nobody would connect to this.
 *
 * So this is checked against a real server on a real port rather than a
 * stubbed fetch. The assertion is that the request arrives here — which it can
 * only do by not having gone to Google.
 */

const messages: Message[] = [{ role: "user", content: "hello" }];

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

/** Records what reaches it and answers with a minimal, valid stream. */
function recordingProxy() {
  const seen: { path: string; apiKey: string | null }[] = [];

  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({
        path: url.pathname,
        // The SDK sends the credential as a header; the proxy authenticates
        // the demo token from exactly here.
        apiKey: request.headers.get("x-goog-api-key"),
      });

      return new Response(
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
        })}\r\n\r\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  return { seen, url: `http://localhost:${server.port}` };
}

async function drain(stream: AsyncGenerator<unknown>) {
  for await (const _ of stream) {
    // The events themselves are covered elsewhere; this file is about where
    // the request went.
  }
}

describe("baseUrl diverts requests away from Google", () => {
  test("geminiClient sends the turn to the base URL it was given", async () => {
    const { seen, url } = recordingProxy();
    const client = geminiClient("demo-token", "gemini-3.5-flash-lite", undefined, url);

    await drain(client.stream(messages, "", undefined, false));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toContain("gemini-3.5-flash-lite");
    expect(seen[0]!.apiKey).toBe("demo-token");
  });

  test("createProviderClient passes it through for google", async () => {
    const { seen, url } = recordingProxy();
    const client = createProviderClient("google", "demo-token", undefined, url);

    await drain(client.stream(messages, "", undefined, false));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.apiKey).toBe("demo-token");
  });

  // The alias is what a config written by an older version stores, and it
  // reaches the same client by a different branch of the switch.
  test("the gemini alias gets it too", async () => {
    const { seen, url } = recordingProxy();
    const client = createProviderClient("gemini", "demo-token", undefined, url);

    await drain(client.stream(messages, "", undefined, false));

    expect(seen).toHaveLength(1);
  });

  /**
   * Where a request would have gone, without letting it go anywhere.
   *
   * The cases below are about traffic that must NOT reach the proxy, and the
   * honest version of that assertion would otherwise be a real call to Google,
   * Anthropic or OpenAI — an outbound request per run, failing whenever CI has
   * no network and reading as a code break. Stubbing the global is the
   * per-file, restorable way to fake a network boundary.
   */
  function recordDestinations() {
    const urls: string[] = [];
    const original = globalThis.fetch;

    globalThis.fetch = (async (input: any, init?: any) => {
      urls.push(typeof input === "string" ? input : (input?.url ?? String(input)));
      throw new Error("blocked in test");
    }) as unknown as typeof fetch;

    return { urls, restore: () => (globalThis.fetch = original) };
  }

  // Not merely untested: forwarding it would point an SDK that speaks another
  // wire format at a proxy that only answers Gemini's.
  test("anthropic and openai ignore it rather than being pointed at the proxy", async () => {
    const proxyUrl = "http://demo.invalid:9999";
    const { urls, restore } = recordDestinations();

    try {
      for (const provider of ["anthropic", "openai"]) {
        const client = createProviderClient(provider, "key", undefined, proxyUrl);
        await drain(client.stream(messages, "", undefined, false)).catch(() => {});
      }
    } finally {
      restore();
    }

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((url) => url.includes("demo.invalid"))).toBe(false);
  });

  test("without a base URL the Gemini client still goes to Google", async () => {
    const { urls, restore } = recordDestinations();

    try {
      const client = createProviderClient("google", "key-only", undefined, undefined);
      await drain(client.stream(messages, "", undefined, false)).catch(() => {});
    } finally {
      restore();
    }

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.includes("generativelanguage.googleapis.com"))).toBe(
      true,
    );
  });
});
