/**
 * Sessions: conversations that survive, keyed by the project they happened in.
 *
 * Woopcode used to keep one `conversation.json` for the whole machine. That
 * made `/new` destructive (there was nowhere for the old transcript to go) and
 * it fed history from one repository into turns taken in another — including
 * the execution log, which the model reads as a description of what has already
 * been done *here*.
 *
 * A session is one JSON file under `sessions/<project-slug>/<id>.json`, and
 * `index.json` beside them is a derived cache so the picker does not have to
 * open every one. The index is never the source of truth: delete it and it is
 * rebuilt by scanning the directory.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "fs";
import { basename, join } from "path";
import type { Message } from "./types";
import type { ExecutionRecord } from "../runtime/executionLog";
import {
  getLegacyConversationPath,
  getLegacyExecutionLogPath,
  getProjectSessionsDir,
  getSessionIndexPath,
  getSessionPath,
  getSessionsDir,
  initializeConfig,
} from "./paths";
import {
  MAX_PERSISTED_RECORDS,
  prepareConversationForDisk,
  readJsonFile,
  writeJsonAtomic,
} from "./config";

/** Bumped when the on-disk shape changes in a way a reader must notice. */
const SESSION_VERSION = 1;

/** The bucket migrated pre-sessions history lands in. */
export const LEGACY_SLUG = "legacy";

export interface SessionRecord {
  version: number;
  id: string;
  /** Set by /rename. The resume handle; a title is not. */
  name: string | null;
  /** Derived from the first prompt, so the picker has something to show. */
  title: string;
  /** Absolute path the session was started in; null for migrated history. */
  cwd: string | null;
  branch: string | null;
  created: number;
  updated: number;
  /** Id of the session this was branched from, if any. */
  forkedFrom: string | null;
  messages: Message[];
  executionLog: ExecutionRecord[];
}

/** One row of the picker. Everything here comes from the index. */
export interface SessionSummary {
  id: string;
  name: string | null;
  title: string;
  cwd: string | null;
  branch: string | null;
  created: number;
  updated: number;
  forkedFrom: string | null;
  messageCount: number;
  /** Which project directory the session was read from. */
  slug: string;
}

interface SessionIndex {
  version: number;
  /** When sessions here were last aged out; see pruneSessions. */
  lastPrunedAt?: number;
  sessions: SessionSummary[];
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/**
 * Characters of the first prompt kept as a title. Long enough to tell two
 * tasks apart in a narrow picker, short enough not to wrap it.
 */
export const MAX_TITLE_CHARS = 60;

/** A session with no first prompt yet. */
export const UNTITLED = "Untitled session";

/**
 * A one-line title from the first thing the user said.
 *
 * Deliberately mechanical rather than model-written: a generated title costs a
 * provider request per session, on whichever of the three providers happens to
 * be configured, and has a failure path to handle at the exact moment a session
 * is being created. `/rename` is there for anyone who wants better.
 */
export function titleFromPrompt(prompt: string): string {
  const flattened = prompt.replace(/\s+/g, " ").trim();
  if (!flattened) return UNTITLED;
  if (flattened.length <= MAX_TITLE_CHARS) return flattened;
  return `${flattened.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}

/**
 * A short, stable hash of a path. Not cryptographic — it exists to keep two
 * different directories out of each other's session list.
 */
function pathHash(path: string): string {
  // FNV-1a. Bun has crypto, but a sync 8-char digest with no allocation is all
  // this needs and it keeps projectSlug a pure synchronous function.
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index++) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The directory name one project's sessions live under.
 *
 * The readable part is for whoever opens the config directory; the hash is what
 * actually keys it. Both are needed: slugifying alone maps `/a/b` and `/a-b` to
 * the same string, which would silently merge two unrelated projects' history.
 */
export function projectSlug(path: string): string {
  const readable =
    basename(path).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
    "project";
  return `${readable}-${pathHash(path)}`;
}

/**
 * Resolves what the user typed to exactly one session.
 *
 * Ordered most to least specific, and ambiguity is reported rather than
 * guessed: resuming the wrong conversation is worse than being asked again.
 */
export type SessionRefResolution =
  | { status: "found"; session: SessionSummary }
  | { status: "none" }
  | { status: "ambiguous"; matches: SessionSummary[] };

export function resolveSessionRef(
  ref: string,
  summaries: readonly SessionSummary[],
): SessionRefResolution {
  const needle = ref.trim();
  if (!needle) return { status: "none" };

  const exactName = summaries.filter((session) => session.name === needle);
  if (exactName.length === 1) return { status: "found", session: exactName[0]! };
  if (exactName.length > 1) return { status: "ambiguous", matches: exactName };

  const exactId = summaries.find((session) => session.id === needle);
  if (exactId) return { status: "found", session: exactId };

  const byPrefix = summaries.filter((session) => session.id.startsWith(needle));
  if (byPrefix.length === 1) return { status: "found", session: byPrefix[0]! };
  if (byPrefix.length > 1) return { status: "ambiguous", matches: byPrefix };

  const lowered = needle.toLowerCase();
  const byTitle = summaries.filter(
    (session) =>
      session.title.toLowerCase().includes(lowered) ||
      (session.name?.toLowerCase().includes(lowered) ?? false),
  );
  if (byTitle.length === 1) return { status: "found", session: byTitle[0]! };
  if (byTitle.length > 1) return { status: "ambiguous", matches: byTitle };

  return { status: "none" };
}

/** Newest first — the order both the picker and `latestSession` want. */
function byRecency(a: SessionSummary, b: SessionSummary): number {
  return b.updated - a.updated;
}

function summarize(record: SessionRecord, slug: string): SessionSummary {
  return {
    id: record.id,
    name: record.name,
    title: record.title,
    cwd: record.cwd,
    branch: record.branch,
    created: record.created,
    updated: record.updated,
    forkedFrom: record.forkedFrom,
    messageCount: record.messages.length,
    slug,
  };
}

// ---------------------------------------------------------------------------
// project resolution
// ---------------------------------------------------------------------------

/**
 * The directory a session belongs to: the repository root when there is one,
 * so `cd packages/x` shares history with the root rather than starting a
 * second store, and the working directory otherwise.
 *
 * Symlinks are resolved first for the same reason `resolveWorkspacePath` does
 * it — two paths that reach the same directory must not produce two slugs.
 */
export function projectRoot(cwd: string = process.cwd()): string {
  let resolved = cwd;
  try {
    resolved = realpathSync(cwd);
  } catch {
    // A cwd that cannot be resolved is still usable as a key.
  }

  let directory = resolved;
  while (true) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = join(directory, "..");
    const parentResolved = (() => {
      try {
        return realpathSync(parent);
      } catch {
        return directory;
      }
    })();
    if (parentResolved === directory) return resolved;
    directory = parentResolved;
  }
}

/** The current git branch, or null outside a repository. */
async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const text = await Bun.$`git -C ${cwd} branch --show-current`.quiet().text();
    return text.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as SessionRecord;
  return (
    typeof record.id === "string" &&
    Array.isArray(record.messages) &&
    Array.isArray(record.executionLog)
  );
}

/** Fills in anything an older or hand-edited file is missing. */
function normalizeRecord(raw: SessionRecord): SessionRecord {
  return {
    ...raw,
    version: typeof raw.version === "number" ? raw.version : SESSION_VERSION,
    name: typeof raw.name === "string" ? raw.name : null,
    title: typeof raw.title === "string" && raw.title ? raw.title : UNTITLED,
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    branch: typeof raw.branch === "string" ? raw.branch : null,
    created: typeof raw.created === "number" ? raw.created : Date.now(),
    updated: typeof raw.updated === "number" ? raw.updated : Date.now(),
    forkedFrom: typeof raw.forkedFrom === "string" ? raw.forkedFrom : null,
    messages: raw.messages.filter(
      (message): message is Message =>
        !!message && typeof message === "object" && typeof message.role === "string",
    ),
    executionLog: raw.executionLog.filter(
      (record): record is ExecutionRecord =>
        !!record &&
        typeof record === "object" &&
        typeof record.tool === "string" &&
        typeof record.outcome === "string",
    ),
  };
}

/**
 * Reads one session. A file that is not a session — corrupt, hand-edited,
 * written by something else — returns null rather than throwing: one bad
 * session must not make the picker unopenable.
 */
export async function loadSession(
  id: string,
  slug: string = projectSlug(projectRoot()),
): Promise<SessionRecord | null> {
  const raw = await readJsonFile(getSessionPath(slug, id), `session ${id}`);
  if (!isSessionRecord(raw)) return null;
  return normalizeRecord(raw);
}

/** Every session directory currently on disk. */
function projectSlugs(): string[] {
  const root = getSessionsDir();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Rebuilds a project's index by opening every session in it.
 *
 * The slow path, taken when the index is missing or unreadable. It is what
 * makes the index safe to treat as a cache: losing it costs one directory scan,
 * never a session.
 */
async function rebuildIndex(slug: string): Promise<SessionSummary[]> {
  const directory = getProjectSessionsDir(slug);
  if (!existsSync(directory)) return [];

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === "index.json") continue;
    const record = await loadSession(entry.slice(0, -".json".length), slug);
    if (record) summaries.push(summarize(record, slug));
  }

  summaries.sort(byRecency);
  await writeIndex(slug, { version: SESSION_VERSION, sessions: summaries });
  return summaries;
}

async function readIndex(slug: string): Promise<SessionIndex | null> {
  const raw = await readJsonFile(getSessionIndexPath(slug), "session index");
  if (!raw || typeof raw !== "object") return null;
  const index = raw as SessionIndex;
  if (!Array.isArray(index.sessions)) return null;
  return index;
}

async function writeIndex(slug: string, index: SessionIndex): Promise<void> {
  mkdirSync(getProjectSessionsDir(slug), { recursive: true });
  await writeJsonAtomic(getSessionIndexPath(slug), index);
}

/**
 * What a caller means when the index it wanted to change is not there.
 *
 * Not a detail to default: saving a record rebuilds from the files on disk so
 * the new row joins the existing ones rather than replacing them; pruning
 * starts from empty because it is about to write the rows it kept; and removing
 * a session does nothing at all, since there is no row to take out and writing
 * an index here would create the directory lazy creation exists to avoid.
 */
type MissingIndex = "rebuild" | "empty" | "skip";

/**
 * Reads a project's index, applies `mutate`, writes the result back.
 *
 * Every caller wants those three steps and no caller wants two of them, but
 * each spelled the sequence out itself — five copies of a read-modify-write
 * that has already lost a row once. This does not close the window between the
 * read and the write; two processes still interleave, which is why
 * `summariesFor` compares the row count against the files on disk and rebuilds
 * when they disagree. It puts the pattern in one place, so the next change to
 * it is one edit rather than five.
 */
async function updateIndex(
  slug: string,
  onMissing: MissingIndex,
  mutate: (index: SessionIndex) => SessionIndex,
): Promise<void> {
  const existing = await readIndex(slug);
  if (!existing && onMissing === "skip") return;

  const index = existing ?? {
    version: SESSION_VERSION,
    sessions: onMissing === "rebuild" ? await rebuildIndex(slug) : [],
  };

  await writeIndex(slug, mutate(index));
}

/** Session files on disk for a project, ignoring the index entirely. */
function sessionFileCount(slug: string): number {
  const directory = getProjectSessionsDir(slug);
  if (!existsSync(directory)) return 0;
  try {
    return readdirSync(directory).filter(
      (entry) => entry.endsWith(".json") && entry !== "index.json",
    ).length;
  } catch {
    return 0;
  }
}

async function summariesFor(slug: string): Promise<SessionSummary[]> {
  const index = await readIndex(slug);
  if (!index) return rebuildIndex(slug);

  // The index is a read-modify-write, so two Woopcode windows in one repository
  // can each save a session and leave only the later row behind. The file is
  // still on disk, and without this check it would never be listed again —
  // a session that silently disappears from the picker. Comparing counts costs
  // one directory read and heals it.
  if (sessionFileCount(slug) !== index.sessions.length) {
    return rebuildIndex(slug);
  }

  return index.sessions.map((session) => ({ ...session, slug })).sort(byRecency);
}

export interface ListOptions {
  /** "project" is the current repository; "all" is every project on disk. */
  scope?: "project" | "all";
  cwd?: string;
}

export async function listSessions(
  options: ListOptions = {},
): Promise<SessionSummary[]> {
  await ensureSessionStore();

  if (options.scope === "all") {
    const all: SessionSummary[] = [];
    for (const slug of projectSlugs()) all.push(...(await summariesFor(slug)));
    return all.sort(byRecency);
  }

  return summariesFor(projectSlug(projectRoot(options.cwd)));
}

/** The session `--continue` and a bare launch reopen. */
export async function latestSession(
  cwd?: string,
): Promise<SessionSummary | null> {
  const sessions = await listSessions({ cwd });
  return sessions[0] ?? null;
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/**
 * Creates a session in memory. Nothing is written until `saveSession` — a
 * session file that exists before any turn has run is a resume target with
 * nothing in it, and every launch would leave one behind.
 */
export async function createSession(
  options: { cwd?: string; name?: string | null; title?: string } = {},
): Promise<SessionRecord> {
  const root = projectRoot(options.cwd);
  const now = Date.now();

  return {
    version: SESSION_VERSION,
    id: crypto.randomUUID(),
    name: options.name ?? null,
    title: options.title ?? UNTITLED,
    cwd: root,
    branch: await currentBranch(root),
    created: now,
    updated: now,
    forkedFrom: null,
    messages: [],
    executionLog: [],
  };
}

/**
 * Writes a session and updates the index to match.
 *
 * The same trim the single conversation file always had is applied here:
 * `prepareConversationForDisk` drops tool traffic and caps the message count.
 * Persisting half of a call/result pair would make the restored history invalid
 * for the provider.
 */
export async function saveSession(record: SessionRecord): Promise<SessionRecord> {
  await ensureSessionStore();
  return writeSessionRecord(record);
}

/**
 * The write itself, without the store-setup guard.
 *
 * Separate because migration runs *inside* that guard: routing it through
 * `saveSession` would have it await the very promise it is part of, and the
 * first launch after an upgrade would hang instead of importing.
 */
async function writeSessionRecord(record: SessionRecord): Promise<SessionRecord> {
  const slug = record.cwd ? projectSlug(record.cwd) : LEGACY_SLUG;
  const trimmed: SessionRecord = {
    ...record,
    version: SESSION_VERSION,
    updated: Date.now(),
    messages: prepareConversationForDisk(record.messages),
    executionLog: record.executionLog.slice(-MAX_PERSISTED_RECORDS),
  };

  mkdirSync(getProjectSessionsDir(slug), { recursive: true });
  await writeJsonAtomic(getSessionPath(slug, trimmed.id), trimmed);

  const summary = summarize(trimmed, slug);
  await updateIndex(slug, "rebuild", (index) => ({
    ...index,
    version: SESSION_VERSION,
    sessions: [
      summary,
      ...index.sessions.filter((session) => session.id !== trimmed.id),
    ].sort(byRecency),
  }));

  return trimmed;
}

/**
 * Loads a session without needing to be told which project it is in.
 *
 * The current project is tried first, so the common case costs one read. The
 * scan matters because a session reached through the picker's all-projects view
 * — or migrated history, which belongs to no project — is not in the current
 * project's directory, and assuming it was made `/branch` fail on exactly the
 * sessions a user is most likely to want a copy of.
 */
async function loadSessionAnywhere(
  id: string,
  slug?: string,
): Promise<SessionRecord | null> {
  const local = await loadSession(id, slug ?? projectSlug(projectRoot()));
  if (local) return local;

  for (const candidate of projectSlugs()) {
    const found = await loadSession(id, candidate);
    if (found) return found;
  }

  return null;
}

/**
 * Re-reads a session from wherever it lives, for checking whether anything else
 * has written it since. Takes the record rather than an id so the project is
 * known — migrated history has none, and a scan would be wasted here.
 */
export async function reloadSession(
  record: SessionRecord,
): Promise<SessionRecord | null> {
  return loadSession(record.id, record.cwd ? projectSlug(record.cwd) : LEGACY_SLUG);
}

/**
 * Drops a session from a project: its file, and its row in that project's
 * index. Best effort — a failure leaves the session listed, which is recoverable
 * in a way a half-removed one is not.
 */
async function removeFromProject(slug: string, id: string): Promise<void> {
  try {
    const path = getSessionPath(slug, id);
    if (existsSync(path)) rmSync(path, { force: true });

    await updateIndex(slug, "skip", (index) => ({
      ...index,
      sessions: index.sessions.filter((session) => session.id !== id),
    }));
  } catch {
    // See above: leaving it listed is the safer failure.
  }
}

/**
 * Moves a session into the project it is now being worked in.
 *
 * This exists for migrated history, which has no project of its own: resuming
 * it in a repository and working for an hour used to leave it in the `legacy`
 * bucket, invisible in that repository's own list, which is the same "where did
 * my conversation go" the session store was built to end.
 *
 * The order is deliberate — the new copy is written before the old one is
 * removed, so an interruption leaves the session listed twice rather than not
 * at all.
 */
export async function adoptSession(
  record: SessionRecord,
  cwd: string = projectRoot(),
): Promise<SessionRecord> {
  const previousSlug = record.cwd ? projectSlug(record.cwd) : LEGACY_SLUG;
  const nextSlug = projectSlug(cwd);
  if (previousSlug === nextSlug) return saveSession(record);

  const adopted = await saveSession({
    ...record,
    cwd,
    branch: await currentBranch(cwd),
  });

  await removeFromProject(previousSlug, record.id);

  return adopted;
}

/**
 * Copies a session under a new id and returns the copy. The original is not
 * touched — that is the whole point of branching.
 */
export async function forkSession(
  id: string,
  options: { name?: string | null; slug?: string } = {},
): Promise<SessionRecord | null> {
  const source = await loadSessionAnywhere(id, options.slug);
  if (!source) return null;

  const now = Date.now();
  const copy: SessionRecord = {
    ...source,
    id: crypto.randomUUID(),
    name: options.name ?? null,
    title: source.title,
    created: now,
    updated: now,
    forkedFrom: source.id,
    // A fork taken from another project's session belongs to the project it was
    // taken in, so it is findable where the work continues.
    cwd: projectRoot(),
    branch: await currentBranch(projectRoot()),
  };

  return saveSession(copy);
}

export async function renameSession(
  id: string,
  name: string,
  slug?: string,
): Promise<SessionRecord | null> {
  const record = await loadSessionAnywhere(id, slug);
  if (!record) return null;
  return saveSession({ ...record, name: name.trim() || null });
}

/**
 * Deletes sessions older than `maxAgeDays`, measured from their last update.
 * A non-positive age keeps everything — the way to turn retention off.
 */
export async function pruneSessions(
  maxAgeDays: number,
  now: number = Date.now(),
): Promise<number> {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return 0;

  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const slug of projectSlugs()) {
    const summaries = await summariesFor(slug);
    const kept: SessionSummary[] = [];
    // Counted per project, not across them. A shared counter rewrote every
    // later project's index — and stamped it as pruned — because an earlier
    // one happened to have something expired in it.
    let removedHere = 0;

    for (const session of summaries) {
      if (session.updated >= cutoff) {
        kept.push(session);
        continue;
      }
      try {
        const path = getSessionPath(slug, session.id);
        if (existsSync(path)) {
          renameSync(path, `${path}.pruned`);
          // Renamed then removed, so a crash between the two leaves a file that
          // is out of the index rather than a half-deleted session in it.
          rmSync(`${path}.pruned`, { force: true });
        }
        removed++;
        removedHere++;
      } catch {
        // A session that cannot be removed stays listed rather than vanishing
        // from the index while its file remains on disk.
        kept.push(session);
      }
    }

    if (removedHere > 0) {
      await updateIndex(slug, "empty", (index) => ({
        ...index,
        version: SESSION_VERSION,
        lastPrunedAt: now,
        sessions: kept,
      }));
    }
  }

  return removed;
}

/** How often retention runs on its own, so startup is not scanning constantly. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Runs retention at most once a day. Called at startup, where the cost has to
 * be near zero on the overwhelmingly common path of having pruned recently.
 */
export async function pruneIfDue(
  maxAgeDays: number,
  now: number = Date.now(),
): Promise<number> {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return 0;

  const slug = projectSlug(projectRoot());

  // A project with no session directory has nothing to age out, and writing an
  // index to record that would create the very directory the lazy-creation
  // rule exists to avoid: starting Woopcode here and quitting must leave
  // nothing behind.
  if (!existsSync(getProjectSessionsDir(slug))) return 0;

  const index = await readIndex(slug);
  if (index?.lastPrunedAt && now - index.lastPrunedAt < PRUNE_INTERVAL_MS) {
    return 0;
  }

  const removed = await pruneSessions(maxAgeDays, now);

  // Stamped even when nothing was removed, or a store with no expired sessions
  // would rescan every launch.
  await updateIndex(slug, "empty", (index) => ({ ...index, lastPrunedAt: now }));

  return removed;
}

// ---------------------------------------------------------------------------
// migration
// ---------------------------------------------------------------------------

/**
 * Moves the pre-sessions `conversation.json` into the session store.
 *
 * It lands in a `legacy` bucket rather than the current project: that file was
 * shared by every repository on the machine, so there is no honest answer to
 * which project it belongs to, and attributing it to whichever one happens to
 * be opened first would be a guess presented as a fact. It is reachable from
 * the picker's all-projects view.
 *
 * Idempotent by the rename: once the sources are `.migrated`, there is nothing
 * left to find.
 */
export async function migrateLegacyConversation(): Promise<SessionRecord | null> {
  const conversationPath = getLegacyConversationPath();
  if (!existsSync(conversationPath)) return null;

  const raw = await readJsonFile(conversationPath, "legacy conversation");
  const messages = Array.isArray(raw)
    ? raw.filter(
        (message): message is Message =>
          !!message && typeof message === "object" && typeof message.role === "string",
      )
    : [];

  const logPath = getLegacyExecutionLogPath();
  const rawLog = existsSync(logPath)
    ? await readJsonFile(logPath, "legacy execution log")
    : undefined;
  const executionLog = Array.isArray(rawLog)
    ? rawLog.filter(
        (record): record is ExecutionRecord =>
          !!record &&
          typeof record === "object" &&
          typeof record.tool === "string" &&
          typeof record.outcome === "string",
      )
    : [];

  // Retire the sources whether or not there was anything worth keeping, so an
  // empty file is not re-read on every launch forever.
  const retire = (path: string) => {
    try {
      if (existsSync(path)) renameSync(path, `${path}.migrated`);
    } catch {
      // Leaving the source in place costs a re-read next launch, which is
      // harmless — the import is keyed on the file existing, not on a flag.
    }
  };

  if (messages.length === 0) {
    retire(conversationPath);
    retire(logPath);
    return null;
  }

  const firstPrompt = messages.find((message) => message.role === "user");
  const now = Date.now();
  const record: SessionRecord = {
    version: SESSION_VERSION,
    id: crypto.randomUUID(),
    name: null,
    title: titleFromPrompt(
      firstPrompt && typeof (firstPrompt as { content?: unknown }).content === "string"
        ? ((firstPrompt as { content: string }).content)
        : "",
    ),
    // Null rather than a guess: this history predates any notion of which
    // project it came from.
    cwd: null,
    branch: null,
    created: fileCreatedAt(conversationPath, now),
    updated: now,
    forkedFrom: null,
    messages,
    executionLog,
  };

  const saved = await writeSessionRecord(record);
  retire(conversationPath);
  retire(logPath);
  return saved;
}

function fileCreatedAt(path: string, fallback: number): number {
  try {
    return statSync(path).birthtimeMs || fallback;
  } catch {
    return fallback;
  }
}

/**
 * One-time setup for the session store.
 *
 * Guarded by a module flag rather than hooked into `initializeConfig`, which
 * `getConfig` calls on every read — migration is a once-per-process concern and
 * does not belong on that path.
 */
let storeReady: Promise<void> | null = null;

export function ensureSessionStore(): Promise<void> {
  storeReady ??= (async () => {
    try {
      await initializeConfig();
      mkdirSync(getSessionsDir(), { recursive: true });
      await migrateLegacyConversation();
    } catch {
      // Config failures never block startup. A store that could not be prepared
      // degrades to a session that will not persist, which is reported when the
      // write itself fails.
    }
  })();

  return storeReady;
}

/** Test seam: forget that setup already ran. */
export function resetSessionStoreForTests(): void {
  storeReady = null;
}
