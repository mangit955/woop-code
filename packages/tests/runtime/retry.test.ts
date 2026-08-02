import { describe, test, expect } from "bun:test";
import {
  backoffDelayMs,
  classifyFailure,
  delay,
  isRetryableError,
  maxAttempts,
  providerRetryDelayMs,
} from "../../../runtime/retry";

describe("retryable failures", () => {
  // The failure that motivated all of this: three concurrent benchmark trials
  // died inside four seconds with exactly this message.
  test("a closed socket is transient", () => {
    expect(
      isRetryableError(
        new Error("The socket connection was closed unexpectedly."),
      ),
    ).toBe(true);
  });

  test.each([
    ["ECONNRESET", "read ECONNRESET"],
    ["fetch failure", "fetch failed"],
    ["DNS", "getaddrinfo EAI_AGAIN generativelanguage.googleapis.com"],
    ["overload", "The model is overloaded. Please try again later."],
    ["own timeout", "Gemini did not respond within 60 seconds."],
  ])("%s is transient", (_label, message) => {
    expect(isRetryableError(new Error(message))).toBe(true);
  });

  test.each([429, 500, 502, 503, 504, 408])("status %i is transient", (status) => {
    expect(isRetryableError(Object.assign(new Error("x"), { status }))).toBe(true);
  });

  test.each([400, 401, 403, 404, 413, 422])(
    "status %i is not transient",
    (status) => {
      expect(isRetryableError(Object.assign(new Error("x"), { status }))).toBe(
        false,
      );
    },
  );

  test("a bad key is never retried, whatever it says", () => {
    // Retrying this burns quota to arrive at the same answer.
    expect(
      isRetryableError(new Error("API key not valid. Please pass a valid API key.")),
    ).toBe(false);
  });

  test("a fatal status wins over transient-looking text", () => {
    const error = Object.assign(new Error("network error"), { status: 400 });
    expect(isRetryableError(error)).toBe(false);
  });

  test("an unrecognised failure is not retried", () => {
    expect(isRetryableError(new Error("something odd"))).toBe(false);
  });

  test("a socket failure wrapped as a cause is still seen", () => {
    const error = new Error("request failed", {
      cause: new Error("The socket connection was closed unexpectedly."),
    });
    expect(isRetryableError(error)).toBe(true);
  });

  test("a nested SDK payload's status is found", () => {
    expect(isRetryableError({ error: { code: 503, message: "unavailable" } })).toBe(
      true,
    );
  });
});

describe("provider-requested delay", () => {
  test("RetryInfo is preferred over guessing", () => {
    const error = {
      status: 429,
      error: {
        details: [
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" },
        ],
      },
    };
    expect(providerRetryDelayMs(error)).toBe(7000);
  });

  test("fractional seconds are handled", () => {
    const error = {
      details: [{ "@type": "google.rpc.RetryInfo", retryDelay: "1.5s" }],
    };
    expect(providerRetryDelayMs(error)).toBe(1500);
  });

  test("an absent RetryInfo yields nothing to prefer", () => {
    expect(providerRetryDelayMs(new Error("boom"))).toBeUndefined();
    expect(providerRetryDelayMs({ details: [] })).toBeUndefined();
  });
});

describe("backoff", () => {
  test("grows with each attempt", () => {
    const noJitter = () => 1;
    const delays = [1, 2, 3, 4].map((n) => backoffDelayMs(n, noJitter));

    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
  });

  test("is capped so a retry never looks like a hang", () => {
    expect(backoffDelayMs(50, () => 1)).toBeLessThanOrEqual(15_000);
  });

  test("is jittered, so concurrent trials do not return together", () => {
    // Every trial in the benchmark failed on one network event; a fixed
    // schedule would send them all back at the same instant.
    expect(backoffDelayMs(3, () => 0)).toBeLessThan(backoffDelayMs(3, () => 1));
  });
});

describe("classification", () => {
  test("stops once the attempts are spent", () => {
    const socket = new Error("The socket connection was closed unexpectedly.");
    expect(classifyFailure(socket, 3, 3)).toEqual({
      retry: false,
      reason: "no attempts left (3/3)",
    });
  });

  test("retries a transient failure while attempts remain", () => {
    const socket = new Error("The socket connection was closed unexpectedly.");
    const decision = classifyFailure(socket, 1, 3, () => 0.5);

    expect(decision.retry).toBe(true);
    expect(decision.retry && decision.delayMs).toBeGreaterThan(0);
  });

  test("never retries a fatal failure, even on the first attempt", () => {
    expect(classifyFailure(new Error("API key not valid"), 1, 3)).toEqual({
      retry: false,
      reason: "not a transient failure",
    });
  });
});

describe("attempt budget", () => {
  test("defaults to three", () => {
    expect(maxAttempts({})).toBe(3);
  });

  test("WOOPCODE_MAX_ATTEMPTS raises it for automated callers", () => {
    expect(maxAttempts({ WOOPCODE_MAX_ATTEMPTS: "10" })).toBe(10);
  });

  test("a nonsense value falls back rather than disabling retries", () => {
    expect(maxAttempts({ WOOPCODE_MAX_ATTEMPTS: "0" })).toBe(3);
    expect(maxAttempts({ WOOPCODE_MAX_ATTEMPTS: "soon" })).toBe(3);
  });
});

describe("abortable delay", () => {
  test("ends early when the turn is cancelled", async () => {
    const controller = new AbortController();
    const started = Date.now();

    const waiting = delay(10_000, controller.signal);
    controller.abort();
    await waiting;

    // Ctrl+C during a backoff must return now, not in ten seconds.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("returns immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const started = Date.now();
    await delay(10_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("waits when nothing cancels it", async () => {
    const started = Date.now();
    await delay(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });
});
