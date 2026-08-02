/**
 * Which provider failures are worth trying again, and how long to wait.
 *
 * A benchmark run showed three concurrent trials dying inside a four-second
 * window with "The socket connection was closed unexpectedly", at prompt sizes
 * from 9k to 54k tokens. One transient network event, and each run lost fifty
 * to eighty iterations of completed work — the loop reported the error and
 * threw, because nothing between the provider call and the top of the loop
 * retried anything.
 *
 * Kept free of I/O so the policy can be tested without a network or a clock.
 */

/** Attempts of a single provider request when nothing overrides it. */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Ceiling on a single backoff wait, so a retry never looks like a hang. */
const MAX_DELAY_MS = 15_000;

/** First backoff step; doubled per attempt. */
const BASE_DELAY_MS = 500;

/**
 * Failures that are a property of the request, not of the moment.
 *
 * Checked before the retryable patterns: a malformed request whose message
 * happens to mention the network must not be retried forever, and retrying a
 * bad key burns quota to arrive at the same answer.
 */
const FATAL_STATUS = new Set([400, 401, 403, 404, 405, 409, 413, 422]);
const FATAL_PATTERNS = [
  /api[ _-]?key/i,
  /unauthenticated/i,
  /permission denied/i,
  /not authorized/i,
  /context length/i,
  /token count exceeds/i,
  /invalid argument/i,
];

/** Failures that are a property of the moment: worth trying again. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_PATTERNS = [
  /socket connection was closed/i,
  /socket hang ?up/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /epipe/i,
  /enotfound/i,
  /eai_again/i,
  /fetch failed/i,
  /network error/i,
  /did not respond within/i, // the request timeout this client raises itself
  /temporarily unavailable/i,
  /overloaded/i,
];

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { status?: unknown; code?: unknown; error?: unknown };

  for (const value of [candidate.status, candidate.code]) {
    if (typeof value === "number") return value;
    // Some SDK errors carry the code as a numeric string.
    if (typeof value === "string" && /^\d{3}$/.test(value)) {
      return Number.parseInt(value, 10);
    }
  }

  // google/genai nests the real payload one level down on some failures.
  const nested = candidate.error;
  if (nested && typeof nested === "object" && nested !== error) {
    return statusOf(nested);
  }

  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // A wrapped socket failure keeps the useful text on `cause`.
    const cause = (error as { cause?: unknown }).cause;
    const causeText =
      cause instanceof Error ? ` ${cause.message}` : typeof cause === "string" ? ` ${cause}` : "";
    return `${error.message}${causeText}`;
  }
  return String(error ?? "");
}

/** Whether the failure is transient rather than inherent to the request. */
export function isRetryableError(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) {
    if (FATAL_STATUS.has(status)) return false;
    if (RETRYABLE_STATUS.has(status)) return true;
  }

  const message = messageOf(error);
  if (FATAL_PATTERNS.some((pattern) => pattern.test(message))) return false;

  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * The delay the provider itself asked for, in milliseconds.
 *
 * A 429 carries a RetryInfo telling you when to come back. Guessing with
 * exponential backoff when the answer is in the response wastes either quota
 * or time, so this wins over the computed schedule when present.
 */
export function providerRetryDelayMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;

  const payload = (error as { error?: unknown }).error ?? error;
  const details = (payload as { details?: unknown }).details;
  if (!Array.isArray(details)) return undefined;

  for (const detail of details) {
    if (!detail || typeof detail !== "object") continue;
    const type = (detail as { "@type"?: unknown })["@type"];
    if (typeof type !== "string" || !type.includes("RetryInfo")) continue;

    const raw = (detail as { retryDelay?: unknown }).retryDelay;
    if (typeof raw !== "string") continue;

    // Protobuf durations are seconds with an `s` suffix ("12s", "1.5s").
    const seconds = Number.parseFloat(raw.replace(/s$/, ""));
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.round(seconds * 1000), MAX_DELAY_MS);
    }
  }

  return undefined;
}

/**
 * Exponential backoff with jitter.
 *
 * The jitter matters more than usual here: concurrent benchmark trials fail
 * together on one network event, and a fixed schedule would send them all back
 * at the same instant.
 */
export function backoffDelayMs(attempt: number, random = Math.random): number {
  const exponential = BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, MAX_DELAY_MS);
  // Full jitter over [capped/2, capped].
  return Math.round(capped / 2 + random() * (capped / 2));
}

export type RetryDecision =
  | { retry: false; reason: string }
  | { retry: true; delayMs: number; reason: string };

/**
 * Resolves the maximum attempts per request, allowing `WOOPCODE_MAX_ATTEMPTS`
 * to change it. An automated harness working one long task tolerates more
 * waiting than a human watching a prompt, which is the same reason
 * WOOPCODE_MAX_ITERATIONS exists.
 */
export function maxAttempts(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.WOOPCODE_MAX_ATTEMPTS?.trim();
  if (!raw) return DEFAULT_MAX_ATTEMPTS;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    process.stderr.write(
      `⚠️  ignoring WOOPCODE_MAX_ATTEMPTS=${raw} (expected a positive integer)\n`,
    );
    return DEFAULT_MAX_ATTEMPTS;
  }
  return parsed;
}

/**
 * Whether to try again after `attempt` failed attempts, and how long to wait.
 *
 * `attempt` is 1-based and counts attempts already made.
 */
export function classifyFailure(
  error: unknown,
  attempt: number,
  limit: number = maxAttempts(),
  random = Math.random,
): RetryDecision {
  if (attempt >= limit) {
    return { retry: false, reason: `no attempts left (${attempt}/${limit})` };
  }

  if (!isRetryableError(error)) {
    return { retry: false, reason: "not a transient failure" };
  }

  const requested = providerRetryDelayMs(error);

  return {
    retry: true,
    delayMs: requested ?? backoffDelayMs(attempt, random),
    reason: requested !== undefined ? "provider asked to retry" : "transient failure",
  };
}

/**
 * A delay that ends early when the turn is cancelled.
 *
 * Without this, Ctrl+C during a fifteen-second backoff would sit there until
 * the wait expired, which reads as a hang rather than a cancellation.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);

    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }

    signal?.addEventListener("abort", finish, { once: true });
  });
}
