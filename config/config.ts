import type { Message } from "./types";
import { getProvidersConfigPath, getConversationPath, initializeConfig } from "./paths";

export async function getConfig() {
  await initializeConfig();
  const configPath = getProvidersConfigPath();
  return JSON.parse(await Bun.file(configPath).text());
}

export async function saveConfig(config: any) {
  await initializeConfig();
  const configPath = getProvidersConfigPath();
  await Bun.write(configPath, JSON.stringify(config, null, 2));
}

// for storing and apending the conversation history
export async function getConversation() {
  await initializeConfig();
  const conversationPath = getConversationPath();
  const file = Bun.file(conversationPath);

  if (!(await file.exists())) {
    return [];
  }

  return JSON.parse(await file.text());
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
