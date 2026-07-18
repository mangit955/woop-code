import type { Message } from "./types";

export async function getConfig() {
  return JSON.parse(await Bun.file("./config/providers.json").text());
}
export async function saveConfig(config: any) {
  await Bun.write("./config/providers.json", JSON.stringify(config, null, 2));
}

// for storing and apending the conversation history
export async function getConversation() {
  const file = await Bun.file("./config/conversation.json");

  if (!file) {
    return [];
  }

  return JSON.parse(await file.text());
}

export async function saveConversation(messages: Message[]) {
  await Bun.write(
    "./config/conversation.json",
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

export async function buildRepositoryContext() {
  const packageJson = await readPackageJson();
  const readme = await readReadme();
  const files = await listRepositoryFiles();

  return `Repository Context\n\nPackage.json:\n${packageJson}\n\nREADME:\n${readme}\n\nFiles:\n${files.join("\n")}`;
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
