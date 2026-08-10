import { join } from "path";
import { getConfigDir } from "./paths";
import type { ProviderEntry } from "./config";
import { readJsonFile } from "./config";

/**
 * Demo mode: running Woopcode without an API key of your own.
 *
 * A shared Gemini key cannot be shipped to users. The free-tier quota belongs
 * to the project rather than the caller, so everyone holding a copy competes
 * for one bucket while a single turn is up to 40 requests; a key printed in a
 * terminal ends up in screenshots and gets revoked; and there is no way to
 * replace it once it is on thousands of disks.
 *
 * So the key stays on a proxy and the client holds a token instead. The token
 * is worthless to Google — it authenticates to Woopcode's proxy, which applies
 * the quota and forwards under the real key. That makes the demo revocable,
 * rationable and switchable off without shipping a release.
 *
 * This module owns the whole lifecycle so no other file knows the endpoint.
 */

/** The provider a demo session runs as; the proxy speaks Gemini's wire format. */
export const DEMO_PROVIDER = "google";

/** Marks a provider entry as demo-issued rather than user-supplied. */
export const DEMO_ENTRY_TYPE = "demo";

/**
 * Where the demo proxy lives when nothing overrides it.
 *
 * This string ends up compiled into every installed copy, and an installed
 * copy is not something that can be corrected later — a user on an older
 * version keeps asking the old host forever. It was `demo.woopcode.dev`
 * before this, a domain that was never registered, so the only thing every
 * install did was fail to resolve it.
 *
 * The escape hatch, if the proxy ever moves off Railway, is a CNAME on a
 * domain that *is* owned, pointed wherever the service goes. Changing this
 * constant again only helps people who upgrade.
 */
const DEFAULT_DEMO_ENDPOINT = "https://woopcode-demo-proxy-production.up.railway.app";

/**
 * The proxy Woopcode's demo talks to.
 *
 * Overridable so the proxy can be run on localhost during development. It is
 * read per call rather than captured at import, because a test that sets the
 * variable in `beforeAll` would otherwise race module loading.
 */
export function demoEndpoint(
  env: Record<string, string | undefined> = process.env,
): string {
  return (env.WOOPCODE_DEMO_URL?.trim() || DEFAULT_DEMO_ENDPOINT).replace(
    /\/+$/,
    "",
  );
}

/** What the proxy hands back when a demo session is granted. */
export interface DemoSession {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Requests this install may make per day, for display only. */
  dailyLimit?: number;
}

function installIdPath(): string {
  return join(getConfigDir(), "install-id.json");
}

/**
 * A stable, random identifier for this installation.
 *
 * The proxy rations per install, and needs something to ration by that is not
 * an IP — shared NATs and cloud egress make addresses both leaky and unfair.
 * It is random and carries nothing about the machine or the user: its only job
 * is to be the same string tomorrow.
 */
export async function getInstallId(): Promise<string> {
  const path = installIdPath();
  const existing = await readJsonFile(path, "install id");

  if (
    existing &&
    typeof existing === "object" &&
    typeof (existing as { installId?: unknown }).installId === "string" &&
    (existing as { installId: string }).installId.length > 0
  ) {
    return (existing as { installId: string }).installId;
  }

  const installId = crypto.randomUUID();
  await Bun.write(path, JSON.stringify({ installId }, null, 2));
  return installId;
}

/**
 * How long to wait for the proxy before giving up on it.
 *
 * Short, because of where this runs. A hung request leaves the wizard on a
 * spinner with no key handler and no way out but Ctrl+C — on the first screen
 * a new user ever sees. Ten seconds is long enough for a cold start and short
 * enough that failing lands them back on "use my own API key" while they are
 * still willing to.
 */
const SESSION_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Asks the proxy for a demo session.
 *
 * Every failure is reported as a message a user can act on, because this runs
 * inside the setup wizard where the alternative on screen is "use my own API
 * key" — a raw fetch error there reads as the product being broken rather than
 * as one optional path being unavailable.
 *
 * @throws If the proxy refuses, is unreachable, or answers with something that
 * is not a session.
 */
export async function requestDemoSession(
  signal?: AbortSignal,
  /** Overridable so a test can prove the deadline fires without waiting it out. */
  timeoutMs: number = SESSION_REQUEST_TIMEOUT_MS,
): Promise<DemoSession> {
  const installId = await getInstallId();
  const endpoint = `${demoEndpoint()}/v1/session`;

  // The caller's signal still wins; this only adds a deadline of its own, so a
  // wizard that is cancelled does not also wait out the timeout.
  const timeout = AbortSignal.timeout(timeoutMs);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installId }),
      signal: deadline,
    });
  } catch (error) {
    const timedOut = timeout.aborted;
    throw new Error(
      timedOut
        ? "The demo service did not respond in time. You can still set up your own API key."
        : `Could not reach the demo service (${
            error instanceof Error ? error.message : "network error"
          }). You can still set up your own API key.`,
    );
  }

  if (!response.ok) {
    // 503 is the kill switch: the demo is off, deliberately, and no amount of
    // retrying changes that. Say so rather than blaming the connection.
    const reason =
      response.status === 503
        ? "The demo is temporarily unavailable."
        : `The demo service refused the request (HTTP ${response.status}).`;
    throw new Error(`${reason} You can still set up your own API key.`);
  }

  const body = (await response.json().catch(() => null)) as Partial<DemoSession> | null;

  if (!body || typeof body.token !== "string" || !body.token) {
    throw new Error(
      "The demo service returned an unusable response. You can still set up your own API key.",
    );
  }

  // An absent or unparseable expiry is treated as already expired rather than
  // as forever. A token with no deadline would sit in the config outliving
  // whatever the server thought it granted, and fail on some later turn
  // instead of here, where there is still a wizard to fall back into.
  const expiresAt =
    typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
      ? body.expiresAt
      : 0;

  return {
    token: body.token,
    expiresAt,
    ...(typeof body.dailyLimit === "number" ? { dailyLimit: body.dailyLimit } : {}),
  };
}

/** The provider entry a granted session is stored as. */
export function demoProviderEntry(session: DemoSession): ProviderEntry {
  return {
    type: DEMO_ENTRY_TYPE,
    apiKey: session.token,
    baseUrl: demoEndpoint(),
    demoExpiresAt: session.expiresAt,
  };
}

/**
 * The marker the proxy puts in the body of a 403 when an install has spent its
 * daily allowance.
 *
 * A token rather than prose, because this is matched against an error message
 * the SDK assembled: matching on wording would break the moment the proxy
 * rephrases its own error, and silently — the user would get the raw provider
 * failure back with no sign that the mapping had stopped working.
 *
 * 403 and not 429 on purpose. `runtime/retry.ts` treats 429 as transient and
 * would spend every attempt re-asking a question whose answer is fixed until
 * tomorrow; 403 is already in its fatal set, so this fails immediately.
 */
export const DEMO_EXHAUSTED_MARKER = "woopcode_demo_exhausted";

/**
 * Rewrites a spent-allowance failure into something a user can act on, or
 * returns null to leave the error alone.
 *
 * Only applies to a demo session: the same marker arriving on a real key would
 * mean something has gone wrong that this message would misdescribe.
 */
export function demoExhaustionMessage(
  error: unknown,
  entry: { baseUrl?: string } | undefined,
): string | null {
  if (!entry?.baseUrl) return null;

  const text = error instanceof Error ? error.message : String(error);
  if (!text.includes(DEMO_EXHAUSTED_MARKER)) return null;

  return (
    "Demo limit reached for today.\n" +
    "Run /login <provider> <api-key> to continue with your own key."
  );
}

export function isDemoEntry(entry: ProviderEntry | undefined): boolean {
  return entry?.type === DEMO_ENTRY_TYPE;
}

/**
 * Whether a demo entry is past its deadline.
 *
 * Only demo entries expire. A user's own key has no `demoExpiresAt` and must
 * never be judged by this — treating a missing deadline as "expired" would
 * lock every ordinary user out of their own credentials.
 */
export function isDemoExpired(
  entry: ProviderEntry | undefined,
  now: number = Date.now(),
): boolean {
  if (!isDemoEntry(entry)) return false;
  return (entry?.demoExpiresAt ?? 0) <= now;
}
