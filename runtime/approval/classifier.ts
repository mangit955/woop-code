/**
 * What kind of command is this?
 *
 * Classification only — it says nothing about whether to ask. That is the
 * policy's job. Keeping the two apart means a new command is one table entry
 * and a new mode is one policy rule, and neither touches the runtime.
 *
 * Two rules shape the whole file:
 *
 *  - **A command line is only as safe as its riskiest part.** `git status &&
 *    rm -rf node_modules` is destructive. Every segment is classified and the
 *    highest risk wins, including inside `$(...)`.
 *  - **Unrecognised means risky.** Anything not in a table is DESTRUCTIVE, so a
 *    command nobody has thought about asks for approval instead of running.
 */

/** Ordered by severity: a higher value always wins when combining segments. */
export enum CommandRisk {
  /** Inspects the workspace and changes nothing. */
  READ_ONLY = 0,
  /** Creates or modifies files inside the workspace. */
  WORKSPACE_WRITE = 1,
  /** Can lose work: deletes, history rewrites, unrecognised commands. */
  DESTRUCTIVE = 2,
  /** Reaches outside the workspace: the machine, the network, permissions. */
  SYSTEM = 3,
}

/** Reads and reports. Nothing here writes to disk on its own. */
const READ_ONLY_COMMANDS = new Set([
  "pwd", "ls", "ll", "tree", "find", "rg", "ag", "ack", "grep", "egrep", "fgrep",
  "cat", "bat", "head", "tail", "stat", "file", "wc", "du", "df", "which", "type",
  "whoami", "hostname", "uname", "date", "echo", "printf", "printenv", "basename",
  "dirname", "realpath", "readlink", "sort", "uniq", "cut", "tr", "jq", "yq",
  "diff", "cmp", "md5sum", "shasum", "sha256sum", "true", "false", "test",
  "pytest", "jest", "vitest", "phpunit", "rspec", "ctest",
]);

/** Writes, but only ever inside the tree it is pointed at. */
const WORKSPACE_WRITE_COMMANDS = new Set([
  "mkdir", "touch", "tee", "patch", "ln",
]);

/** Can destroy work that is not recoverable from the workspace itself. */
const DESTRUCTIVE_COMMANDS = new Set([
  "rm", "rmdir", "unlink", "shred", "truncate", "dd", "mkfs",
  "kill", "killall", "pkill",
]);

/** Touches the machine, the network, or permissions. */
const SYSTEM_COMMANDS = new Set([
  "sudo", "su", "doas", "chmod", "chown", "chgrp", "chflags",
  "systemctl", "launchctl", "service", "mount", "umount", "diskutil",
  "apt", "apt-get", "yum", "dnf", "pacman", "brew", "port", "snap",
  "curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "telnet",
  "docker", "podman", "kubectl", "helm", "terraform",
  "defaults", "networksetup", "ifconfig", "route", "iptables",
  "reboot", "shutdown", "halt", "crontab", "at",
]);

/**
 * Prefixes that wrap another command. `sudo` is special: it is itself a system
 * escalation, so it is not stripped — it is classified.
 */
const TRANSPARENT_PREFIXES = new Set([
  "time", "nohup", "nice", "ionice", "command", "builtin", "exec", "env", "stdbuf",
]);

/** Writing here changes nothing, so a redirect to it is not a write. */
const HARMLESS_REDIRECT_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

type SubcommandClassifier = (args: string[]) => CommandRisk;

/**
 * Commands whose risk depends entirely on their arguments. Without these,
 * `git log` and `git reset --hard` would be indistinguishable.
 */
const ARGUMENT_SENSITIVE: Record<string, SubcommandClassifier> = {
  git: classifyGit,
  npm: classifyNodePackageManager,
  pnpm: classifyNodePackageManager,
  yarn: classifyNodePackageManager,
  bun: classifyNodePackageManager,
  cargo: classifyCargo,
  go: classifyGo,
  pip: classifyPip,
  pip3: classifyPip,
  sed: classifySed,
  find: classifyFind,
  awk: classifyAwk,
  mv: classifyPathMover,
  cp: classifyPathMover,
};

export function classifyCommand(command: string): CommandRisk {
  const segments = splitSegments(command);

  // Nothing to run is nothing to worry about, but it must not read as safe
  // either — an empty command is a caller bug, not a read.
  if (segments.length === 0) return CommandRisk.DESTRUCTIVE;

  return segments.reduce<CommandRisk>(
    (highest, segment) => Math.max(highest, classifySegment(segment)),
    CommandRisk.READ_ONLY,
  );
}

function classifySegment(segment: string): CommandRisk {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return CommandRisk.READ_ONLY;

  const redirect = classifyRedirect(tokens);
  const [name, args] = resolveCommand(tokens);
  if (!name) return Math.max(redirect, CommandRisk.READ_ONLY);

  return Math.max(redirect, classifyProgram(name, args));
}

/**
 * Strips leading environment assignments and wrapper commands to find the
 * program that actually runs. `FOO=bar time ls` is an `ls`.
 */
function resolveCommand(tokens: string[]): [string | undefined, string[]] {
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index]!;

    // VAR=value prefixes
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }

    const name = basename(token);
    if (TRANSPARENT_PREFIXES.has(name)) {
      index += 1;
      // `env -i`, `nice -n 10`: skip the wrapper's own flags.
      while (index < tokens.length && tokens[index]!.startsWith("-")) index += 1;
      continue;
    }

    return [name, tokens.slice(index + 1)];
  }

  return [undefined, []];
}

function classifyProgram(name: string, args: string[]): CommandRisk {
  const handler = ARGUMENT_SENSITIVE[name];
  if (handler) return handler(args);

  if (SYSTEM_COMMANDS.has(name)) return CommandRisk.SYSTEM;
  if (DESTRUCTIVE_COMMANDS.has(name)) return CommandRisk.DESTRUCTIVE;
  if (WORKSPACE_WRITE_COMMANDS.has(name)) return CommandRisk.WORKSPACE_WRITE;
  if (READ_ONLY_COMMANDS.has(name)) return CommandRisk.READ_ONLY;

  // Unrecognised: it asks. Adding a command to a table is the way to make it
  // run unattended, never a guess made here.
  return CommandRisk.DESTRUCTIVE;
}

// ─── Per-command rules ───────────────────────────────────────────────────────

const GIT_READ_ONLY = new Set([
  "status", "diff", "log", "show", "blame", "shortlog", "describe", "grep",
  "rev-parse", "ls-files", "ls-tree", "cat-file", "diff-tree", "whatchanged",
  "reflog", "count-objects", "verify-commit", "check-ignore",
]);
const GIT_WORKSPACE_WRITE = new Set([
  "add", "commit", "mv", "switch", "apply", "cherry-pick", "revert", "init",
  "merge", "stash", "worktree", "notes", "am",
]);
const GIT_DESTRUCTIVE = new Set(["reset", "clean", "rm", "restore", "rebase", "filter-branch", "gc", "prune"]);
/** Anything that talks to a remote. */
const GIT_NETWORK = new Set(["push", "pull", "fetch", "clone", "remote", "submodule", "archive"]);

function classifyGit(args: string[]): CommandRisk {
  const [subcommand, ...rest] = args.filter((arg) => !arg.startsWith("-"));
  if (!subcommand) return CommandRisk.READ_ONLY; // bare `git` prints usage

  if (GIT_NETWORK.has(subcommand)) {
    // `git remote -v` and `git remote` only report.
    if (subcommand === "remote" && rest.length === 0) return CommandRisk.READ_ONLY;
    return CommandRisk.SYSTEM;
  }

  if (GIT_DESTRUCTIVE.has(subcommand)) return CommandRisk.DESTRUCTIVE;

  // Listing branches or tags reads; deleting one does not.
  if (subcommand === "branch" || subcommand === "tag") {
    const deletes = args.some((arg) => arg === "-d" || arg === "-D" || arg === "--delete");
    return deletes ? CommandRisk.DESTRUCTIVE : CommandRisk.READ_ONLY;
  }

  if (subcommand === "checkout") {
    // `git checkout -- path` discards uncommitted work in that path.
    return args.includes("--") ? CommandRisk.DESTRUCTIVE : CommandRisk.WORKSPACE_WRITE;
  }

  if (subcommand === "config") {
    const reads = args.some((arg) => arg === "--get" || arg === "--list" || arg === "-l");
    return reads ? CommandRisk.READ_ONLY : CommandRisk.WORKSPACE_WRITE;
  }

  if (subcommand === "stash") {
    const [action] = rest;
    if (action === "list" || action === "show") return CommandRisk.READ_ONLY;
    if (action === "drop" || action === "clear") return CommandRisk.DESTRUCTIVE;
    return CommandRisk.WORKSPACE_WRITE;
  }

  if (GIT_WORKSPACE_WRITE.has(subcommand)) return CommandRisk.WORKSPACE_WRITE;
  if (GIT_READ_ONLY.has(subcommand)) return CommandRisk.READ_ONLY;

  return CommandRisk.DESTRUCTIVE;
}

/** Installing reaches the network and rewrites node_modules. */
const PACKAGE_NETWORK = new Set([
  "install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up",
  "upgrade", "ci", "link", "unlink", "publish", "pack", "audit", "dedupe",
  "create", "init", "x", "dlx", "exec",
]);

function classifyNodePackageManager(args: string[]): CommandRisk {
  const [subcommand] = args.filter((arg) => !arg.startsWith("-"));
  if (!subcommand) return CommandRisk.READ_ONLY;

  if (subcommand === "test" || subcommand === "t") return CommandRisk.READ_ONLY;
  if (subcommand === "ls" || subcommand === "list" || subcommand === "why" || subcommand === "outdated") {
    return CommandRisk.READ_ONLY;
  }
  if (PACKAGE_NETWORK.has(subcommand)) return CommandRisk.SYSTEM;

  // `npm run <script>` and `bun <file>` run code this module cannot see.
  return CommandRisk.DESTRUCTIVE;
}

function classifyCargo(args: string[]): CommandRisk {
  const [subcommand] = args.filter((arg) => !arg.startsWith("-"));
  if (!subcommand) return CommandRisk.READ_ONLY;

  if (["test", "check", "clippy", "tree", "metadata", "fmt"].includes(subcommand)) {
    return subcommand === "fmt" ? CommandRisk.WORKSPACE_WRITE : CommandRisk.READ_ONLY;
  }
  if (["build", "doc", "bench"].includes(subcommand)) return CommandRisk.WORKSPACE_WRITE;
  if (["install", "publish", "add", "remove", "update"].includes(subcommand)) return CommandRisk.SYSTEM;

  return CommandRisk.DESTRUCTIVE;
}

function classifyGo(args: string[]): CommandRisk {
  const [subcommand] = args.filter((arg) => !arg.startsWith("-"));
  if (!subcommand) return CommandRisk.READ_ONLY;

  if (["test", "vet", "list", "env", "version", "doc"].includes(subcommand)) return CommandRisk.READ_ONLY;
  if (["build", "fmt", "generate", "mod"].includes(subcommand)) return CommandRisk.WORKSPACE_WRITE;
  if (["get", "install", "clean"].includes(subcommand)) return CommandRisk.SYSTEM;

  return CommandRisk.DESTRUCTIVE;
}

function classifyPip(args: string[]): CommandRisk {
  const [subcommand] = args.filter((arg) => !arg.startsWith("-"));
  if (subcommand === "list" || subcommand === "show" || subcommand === "freeze") {
    return CommandRisk.READ_ONLY;
  }
  return CommandRisk.SYSTEM;
}

/** `sed -i` rewrites files in place; every other form streams to stdout. */
function classifySed(args: string[]): CommandRisk {
  const inPlace = args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place");
  return inPlace ? CommandRisk.WORKSPACE_WRITE : CommandRisk.READ_ONLY;
}

/** `find -delete` and `find -exec` turn a search into anything at all. */
function classifyFind(args: string[]): CommandRisk {
  if (args.includes("-delete")) return CommandRisk.DESTRUCTIVE;
  if (args.includes("-exec") || args.includes("-execdir") || args.includes("-ok")) {
    return CommandRisk.DESTRUCTIVE;
  }
  return CommandRisk.READ_ONLY;
}

/** gawk can write files with `> file` inside its program text. */
function classifyAwk(args: string[]): CommandRisk {
  const program = args.join(" ");
  return program.includes(">") ? CommandRisk.WORKSPACE_WRITE : CommandRisk.READ_ONLY;
}

/**
 * Moving and copying inside the workspace is ordinary editing; doing it across
 * the workspace boundary is not something to do unattended.
 */
function classifyPathMover(args: string[]): CommandRisk {
  const paths = args.filter((arg) => !arg.startsWith("-"));
  return paths.some(isOutsideWorkspace) ? CommandRisk.SYSTEM : CommandRisk.WORKSPACE_WRITE;
}

/**
 * Absolute paths and `~` leave the workspace, and so does any `..` that climbs
 * past its own root. Conservative on purpose: a path this cannot resolve counts
 * as outside.
 */
export function isOutsideWorkspace(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("~")) return true;

  let depth = 0;
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      depth -= 1;
      if (depth < 0) return true;
      continue;
    }
    depth += 1;
  }

  return false;
}

// ─── Shell parsing ───────────────────────────────────────────────────────────

/**
 * Splits a command line into independently classifiable segments: pipelines,
 * `&&`/`||`/`;` chains, and the insides of `$(...)` and backticks.
 *
 * Quotes are respected, so `grep "a && b" file` stays one segment and cannot be
 * mistaken for a chain.
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let index = 0;

  const push = () => {
    if (current.trim() !== "") segments.push(current.trim());
    current = "";
  };

  while (index < command.length) {
    const char = command[index]!;

    if (quote) {
      if (char === quote) quote = null;
      // A backslash inside double quotes escapes the next character.
      else if (char === "\\" && quote === '"') index += 1;
      current += char;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      index += 1;
      continue;
    }

    if (char === "\\") {
      // Escaped character: it cannot be an operator.
      current += command.slice(index, index + 2);
      index += 2;
      continue;
    }

    if (char === "#") {
      // Comment to end of line.
      const newline = command.indexOf("\n", index);
      if (newline === -1) break;
      index = newline;
      continue;
    }

    // Command substitution: the inside is its own command line.
    if (char === "$" && command[index + 1] === "(") {
      const end = matchClosingParenthesis(command, index + 1);
      segments.push(...splitSegments(command.slice(index + 2, end)));
      index = end + 1;
      continue;
    }

    if (char === "`") {
      const end = command.indexOf("`", index + 1);
      const stop = end === -1 ? command.length : end;
      segments.push(...splitSegments(command.slice(index + 1, stop)));
      index = stop + 1;
      continue;
    }

    if (char === "(" || char === ")") {
      // Subshell grouping: the contents are still classified, the parens are not.
      push();
      index += 1;
      continue;
    }

    const two = command.slice(index, index + 2);
    if (two === "&&" || two === "||") {
      push();
      index += 2;
      continue;
    }

    if (char === ";" || char === "|" || char === "\n" || char === "&") {
      push();
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  push();
  return segments;
}

function matchClosingParenthesis(source: string, open: number) {
  let depth = 0;

  for (let index = open; index < source.length; index++) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return source.length;
}

/** Splits a segment into tokens, keeping quoted runs together and unquoted. */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  const push = () => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };

  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]!;

    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }

    if (char === "\\") {
      current += segment[index + 1] ?? "";
      started = true;
      index += 1;
      continue;
    }

    if (/\s/.test(char)) {
      push();
      continue;
    }

    current += char;
    started = true;
  }

  push();
  return tokens;
}

/**
 * A redirect is a write even when the command itself only reads: `cat a > b`
 * creates b. Writing outside the workspace is a system change.
 */
function classifyRedirect(tokens: string[]): CommandRisk {
  let risk = CommandRisk.READ_ONLY;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const match = /^\d*(>>|>)(.*)$/.exec(token);
    if (!match) continue;

    const target = match[2] !== "" ? match[2]! : (tokens[index + 1] ?? "");
    if (target === "" || target.startsWith("&")) continue; // `2>&1` duplicates a handle
    if (HARMLESS_REDIRECT_TARGETS.has(target)) continue;

    risk = Math.max(
      risk,
      isOutsideWorkspace(target) ? CommandRisk.SYSTEM : CommandRisk.WORKSPACE_WRITE,
    );
  }

  return risk;
}

function basename(token: string) {
  const withoutPath = token.split("/").pop() ?? token;
  return withoutPath.toLowerCase();
}

/** For messages and tests: a short name for a risk level. */
export function describeRisk(risk: CommandRisk): string {
  switch (risk) {
    case CommandRisk.READ_ONLY:
      return "read-only";
    case CommandRisk.WORKSPACE_WRITE:
      return "writes to the workspace";
    case CommandRisk.DESTRUCTIVE:
      return "may destroy work";
    case CommandRisk.SYSTEM:
      return "affects the system";
  }
}
