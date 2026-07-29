import { renameSync } from "fs";
import type { Message } from "./types";
import { getProvidersConfigPath, getConversationPath, initializeConfig } from "./paths";

export interface ProviderEntry {
  type?: string;
  apiKey?: string;
}

export interface ProvidersConfig {
  defaultProvider: string;
  selectedModel?: string;
  providers: Record<string, ProviderEntry>;
}

/**
 * Reads and parses a JSON file. A file that is corrupt (truncated write, hand
 * edit, disk error) is moved aside rather than crashing every command that
 * touches config — the user keeps the broken copy, and startup continues from
 * a clean default.
 */
async function readJsonFile(path: string, label: string): Promise<unknown> {
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
    providers,
  };
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

// for storing and apending the conversation history
export async function getConversation(): Promise<Message[]> {
  await initializeConfig();
  const conversationPath = getConversationPath();

  const parsed = await readJsonFile(conversationPath, "conversation history");

  // A conversation that is not a list of messages is not worth recovering
  // partially; starting a fresh transcript beats crashing on every launch.
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter(
    (message): message is Message =>
      !!message && typeof message === "object" && typeof (message as Message).role === "string",
  );
}

export async function saveConversation(messages: Message[]) {
  await initializeConfig();
  const conversationPath = getConversationPath();
  await Bun.write(
    conversationPath,
    JSON.stringify(messages, null, 2),
  );
}

export async function appendMessage(message: any) {
  const conversation = await getConversation();

  conversation.push(message);

  await saveConversation(conversation);
}

// for context building
export async function readPackageJson() {
  const file = Bun.file(`${process.cwd()}/package.json`);

  if (!(await file.exists())) {
    return "";
  }

  return await file.text();
}

export async function readReadme() {
  const file = Bun.file(`${process.cwd()}/README.md`);

  if (!(await file.exists())) {
    return "";
  }

  return await file.text();
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
  const packageJson = await readPackageJson();
  const readme = await readReadme();
  const structure = await getProjectStructure();
  
  // Don't include full file list - it can be massive and waste tokens
  // The agent has list_files and find_files tools to discover files on demand
  let contextParts = ["Repository Context"];
  
  if (packageJson) {
    contextParts.push(`\nPackage.json:\n${packageJson}`);
  }
  
  if (readme) {
    contextParts.push(`\nREADME:\n${readme}`);
  }
  
  if (structure) {
    contextParts.push(`\nTop-level structure:\n${structure}\n\nUse find_files or list_files to explore deeper.`);
  }
  
  return contextParts.join("");
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
