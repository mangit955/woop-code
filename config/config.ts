import { renameSync } from "fs";
import type { Message } from "./types";
import { getProvidersConfigPath, initializeConfig } from "./paths";
import { type ApprovalMode, parseApprovalMode } from "../runtime/approval";

export interface ProviderEntry {
  type?: string;
  apiKey?: string;
}

export interface ProvidersConfig {
  defaultProvider: string;
  selectedModel?: string;
  /** How much the agent may run without asking; see runtime/approval. */
  approvalMode?: ApprovalMode;
  /** Days a session survives after its last turn; 0 keeps them forever. */
  retentionDays?: number;
  providers: Record<string, ProviderEntry>;
}

/**
 * How long a session lives after its last turn.
 *
 * Thirty days is what Claude Code defaults to and it is the right shape of
 * number: long enough that coming back to last month's work still finds it,
 * short enough that the store does not grow without bound.
 */
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * Reads the retention setting, falling back to the default for anything that is
 * not a usable number. Zero and negatives are honoured as "keep forever" rather
 * than corrected — that is how retention is turned off.
 */
export function parseRetentionDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RETENTION_DAYS;
  }
  return value < 0 ? 0 : value;
}

/**
 * Reads and parses a JSON file. A file that is corrupt (truncated write, hand
 * edit, disk error) is moved aside rather than crashing every command that
 * touches config — the user keeps the broken copy, and startup continues from
 * a clean default.
 */
export async function readJsonFile(path: string, label: string): Promise<unknown> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return undefined;
  }

  const text = await file.text();

  try {
    return JSON.parse(text);
  } catch {
    // Move the broken file aside so the defaults can be recreated in its place
    // and the next launch is clean, while the original stays recoverable.
    const backup = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, backup);
      console.error(`Could not read ${label} (invalid JSON). Moved it to ${backup} and started from defaults.`);
    } catch {
      console.error(`Could not read ${label} (invalid JSON). Starting from defaults.`);
    }
    return undefined;
  }
}

/**
 * Fills in whatever the config is missing so callers never index into an
 * undefined `providers` map. Unrecognised extra keys are preserved.
 */
export function normalizeConfig(raw: unknown): ProvidersConfig {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawProviders =
    source.providers && typeof source.providers === "object"
      ? (source.providers as Record<string, unknown>)
      : {};

  const providers: Record<string, ProviderEntry> = {};
  for (const [name, entry] of Object.entries(rawProviders)) {
    if (!entry || typeof entry !== "object") continue;
    const { type, apiKey } = entry as ProviderEntry;
    providers[name] = {
      ...(typeof type === "string" ? { type } : { type: "api" }),
      ...(typeof apiKey === "string" ? { apiKey } : {}),
    };
  }

  return {
    ...source,
    defaultProvider:
      typeof source.defaultProvider === "string" ? source.defaultProvider : "",
    ...(typeof source.selectedModel === "string"
      ? { selectedModel: source.selectedModel }
      : {}),
    // Always normalised, so an absent or misspelt setting cannot leave the
    // approval mode undefined at the point a command is about to run.
    approvalMode: parseApprovalMode(source.approvalMode),
    // The spread above preserves unrecognised keys, which would leave a
    // hand-written `retentionDays: "30"` intact and unusable. Normalise it for
    // the same reason the approval mode is normalised.
    retentionDays: parseRetentionDays(source.retentionDays),
    providers,
  };
}

/**
 * The approval mode for the next command. Read per command rather than cached,
 * so changing it with /approval takes effect immediately.
 */
export async function getApprovalMode(): Promise<ApprovalMode> {
  try {
    return parseApprovalMode((await getConfig()).approvalMode);
  } catch {
    // An unreadable config must not widen permissions.
    return parseApprovalMode(undefined);
  }
}

export async function saveApprovalMode(mode: ApprovalMode) {
  const config = await getConfig();
  config.approvalMode = mode;
  await saveConfig(config);
}

export async function getConfig(): Promise<ProvidersConfig> {
  await initializeConfig();
  const configPath = getProvidersConfigPath();

  let raw = await readJsonFile(configPath, "provider config");

  // The file was quarantined just now; recreate the defaults in its place so
  // the provider list and onboarding behave like a fresh install.
  if (raw === undefined) {
    await initializeConfig();
    raw = await readJsonFile(configPath, "provider config");
  }

  return normalizeConfig(raw);
}

export async function saveConfig(config: ProvidersConfig) {
  await initializeConfig();
  const configPath = getProvidersConfigPath();
  await Bun.write(configPath, JSON.stringify(config, null, 2));
}

/**
 * Writes JSON to a temporary sibling and renames it over the target.
 *
 * The rename is atomic on the same filesystem, so a crash mid-write leaves
 * either the old file or the new one, never half of either. Everything that
 * persists user state goes through here — a session, its index, the config —
 * because all of them are written often enough to hit that window.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await Bun.write(temporaryPath, JSON.stringify(value, null, 2));
  renameSync(temporaryPath, path);
}

/**
 * How many messages are kept on disk. History exists to give a new session
 * context, not to be a complete archive, and the provider is only sent a few
 * recent turns anyway (see recentMessages).
 */
export const MAX_PERSISTED_MESSAGES = 100;

/**
 * Trims a conversation to what is worth keeping between sessions.
 *
 * Tool calls and their results are dropped: they are the bulk of a long
 * transcript, they are only meaningful to the turn that produced them, and
 * persisting one half of a call/result pair would make the restored history
 * invalid for the provider.
 */
export function prepareConversationForDisk(messages: Message[]): Message[] {
  const conversational = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );

  return conversational.slice(-MAX_PERSISTED_MESSAGES);
}

/**
 * How many execution records are kept on disk.
 *
 * Generous compared with what is actually sent: the render budget decides that,
 * and these are one short line each, so keeping more costs disk rather than
 * tokens.
 */
export const MAX_PERSISTED_RECORDS = 200;

// ==================== REPOSITORY CONTEXT ====================
//
// This context is prepended to every model request, so it is budgeted rather
// than dumped. The agent can always read the full files on demand with
// read_file, so anything cut here costs at most one tool call.

/** Never read a context file larger than this into memory. */
export const MAX_CONTEXT_FILE_BYTES = 512 * 1024;
export const MAX_PACKAGE_JSON_CHARS = 2_000;
export const MAX_README_CHARS = 4_000;
/**
 * Budget for the repository's instructions to the agent.
 *
 * Larger than it looks: this is paid on every iteration, and the benchmark
 * measured the fixed part of the prompt at 84% of the first request. It earns
 * that because instructions are rules the project has already decided, and an
 * agent that has to infer them spends whole iterations rediscovering what one
 * file states outright.
 */
export const MAX_INSTRUCTIONS_CHARS = 4_000;
/** Ceiling for the assembled context, applied after the per-file limits. */
export const MAX_REPO_CONTEXT_CHARS = 12_000;

/** Number of dependency names kept per section before summarising the rest. */
const MAX_DEPENDENCIES_LISTED = 40;

/**
 * Cuts text to `limit`, preferring the last line break so the result does not
 * end mid-line, and says what was dropped.
 */
export function truncate(text: string, limit: number, hint: string): string {
  if (text.length <= limit) return text;

  const slice = text.slice(0, limit);
  const lastBreak = slice.lastIndexOf("\n");
  const kept = lastBreak > limit * 0.5 ? slice.slice(0, lastBreak) : slice;
  const dropped = text.length - kept.length;

  return `${kept}\n… (${dropped} more characters omitted — ${hint})`;
}

/** Reads a context file, skipping anything too large to belong in a prompt. */
async function readContextFile(path: string): Promise<string> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return "";
  }

  // Bun.file exposes the size without reading the contents, so an accidental
  // multi-megabyte README never reaches memory.
  if (file.size > MAX_CONTEXT_FILE_BYTES) {
    return "";
  }

  try {
    return await file.text();
  } catch {
    return "";
  }
}

/**
 * Summarises package.json instead of inlining it. The useful signal is the
 * project identity, its scripts and which libraries it uses — not the exact
 * version ranges, which dominate the file and change nothing for the agent.
 */
export async function readPackageJson() {
  const text = await readContextFile(`${process.cwd()}/package.json`);

  if (!text) return "";

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Malformed package.json still carries information; keep a bounded slice.
    return truncate(text, MAX_PACKAGE_JSON_CHARS, "read package.json for the rest");
  }

  const lines: string[] = [];
  const identity = [parsed?.name, parsed?.version].filter(Boolean).join("@");
  if (identity) lines.push(`name: ${identity}`);
  if (typeof parsed?.description === "string") lines.push(`description: ${parsed.description}`);
  if (typeof parsed?.type === "string") lines.push(`type: ${parsed.type}`);

  const scripts = Object.keys(parsed?.scripts ?? {});
  if (scripts.length > 0) lines.push(`scripts: ${scripts.join(", ")}`);

  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const names = Object.keys(parsed?.[field] ?? {});
    if (names.length === 0) continue;

    const listed = names.slice(0, MAX_DEPENDENCIES_LISTED);
    const rest = names.length - listed.length;
    lines.push(
      `${field}: ${listed.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`,
    );
  }

  return truncate(
    lines.join("\n"),
    MAX_PACKAGE_JSON_CHARS,
    "read package.json for the rest",
  );
}

export async function readReadme() {
  const text = await readContextFile(`${process.cwd()}/README.md`);

  return truncate(text, MAX_README_CHARS, "read README.md for the rest");
}

/**
 * Filenames holding repository instructions for a coding agent, in preference
 * order. Only the first one found is used: a repository carrying both usually
 * has the same content twice, and sending both would spend the budget saying
 * it once more.
 *
 * AGENTS.md is the vendor-neutral name and comes first. The rest are read
 * because a repository set up for another tool has already written down the
 * conventions Woopcode needs, and refusing to read them on branding grounds
 * would only make the agent guess at rules the project has already stated.
 */
export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules"];

/**
 * Reads the repository's own instructions to the agent.
 *
 * Woopcode advertised repository awareness while reading nothing but
 * package.json, the README and a top-level listing — so a project stating its
 * conventions in AGENTS.md had them ignored, and the agent inferred from
 * surrounding code what the repository had spelled out.
 */
export async function readAgentInstructions(): Promise<{
  name: string;
  text: string;
} | null> {
  for (const name of INSTRUCTION_FILES) {
    const text = await readContextFile(`${process.cwd()}/${name}`);
    if (text.trim()) {
      return {
        name,
        text: truncate(text, MAX_INSTRUCTIONS_CHARS, `read ${name} for the rest`),
      };
    }
  }

  return null;
}

export async function listRepositoryFiles() {
  const root = process.cwd();

  const files: string[] = [];

  for await (const entry of new Bun.Glob("**/*").scan(root)) {
    if (
      entry.startsWith("node_modules") ||
      entry.startsWith(".git") ||
      entry.startsWith("dist")
    ) {
      continue;
    }

    files.push(entry);
  }

  return files;
}

export async function getProjectStructure() {
  const root = process.cwd();
  const topLevel: string[] = [];
  
  try {
    // Only get top-level directories and key files
    for await (const entry of new Bun.Glob("*").scan(root)) {
      if (entry === "node_modules" || entry === ".git") {
        continue;
      }
      
      topLevel.push(entry);
      
      // Limit to 50 entries to avoid token waste
      if (topLevel.length >= 50) {
        break;
      }
    }
  } catch {
    return "";
  }
  
  return topLevel.sort().join("\n");
}

export async function buildRepositoryContext() {
  const instructions = await readAgentInstructions();
  const packageJson = await readPackageJson();
  const readme = await readReadme();
  const structure = await getProjectStructure();

  // Don't include full file list - it can be massive and waste tokens
  // The agent has list_files and find_files tools to discover files on demand
  let contextParts = ["Repository Context"];

  // First, because the ceiling below cuts from the end: if anything has to go,
  // it should be the README rather than the rules the project wrote down.
  if (instructions) {
    contextParts.push(
      `\nRepository instructions (${instructions.name}) — follow these; they override general conventions:\n${instructions.text}`,
    );
  }

  if (packageJson) {
    contextParts.push(`\nPackage.json (summary):\n${packageJson}`);
  }

  if (readme) {
    contextParts.push(`\nREADME (may be truncated):\n${readme}`);
  }

  if (structure) {
    contextParts.push(`\nTop-level structure:\n${structure}\n\nUse find_files or list_files to explore deeper.`);
  }

  // Each part is already bounded; this is the backstop that keeps the total
  // predictable however the parts grow.
  return truncate(
    contextParts.join(""),
    MAX_REPO_CONTEXT_CHARS,
    "use read_file, find_files or list_files for anything else",
  );
}

export function recentMessages(
  message: Message[],
  maxTurns: number,
): Message[] {
  if (maxTurns <= 0 || message.length === 0) {
    return [];
  }

  let userTurn = 0;
  let startIndex = 0;

  for (let i = message.length - 1; i >= 0; i--) {
    if (message[i]?.role === "user") {
      userTurn++;

      if (userTurn == maxTurns) {
        startIndex = i;
        break;
      }
    }
  }

  return message.slice(startIndex);
}
