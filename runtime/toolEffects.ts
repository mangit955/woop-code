/**
 * What each tool does to the workspace.
 *
 * The tool registry does not carry this: approval is enforced inside the tool
 * implementations and in the approval policy, not declared as tool metadata.
 * It lived in site/scripts/extract.ts, which needed it to document how each
 * tool is gated. The runtime now needs the same classification to tell a turn
 * that changed files from one that only read them, and two copies of a list
 * like this is exactly how the second one goes stale.
 *
 * Keyed by tool name so an added tool reads as `unclassified` rather than
 * being silently treated as harmless.
 */
export type ToolEffect = "read" | "write" | "shell" | "ask" | "unclassified";

export const TOOL_EFFECTS: Record<string, Exclude<ToolEffect, "unclassified">> = {
  list_files: "read",
  read_file: "read",
  grep: "read",
  glob: "read",
  find_files: "read",
  web_search: "read",
  web_fetch: "read",
  create_file: "write",
  write_file: "write",
  edit_file: "write",
  run_terminal: "shell",
  run_tests: "shell",
  ask_user: "ask",
};

export function toolEffect(name: string): ToolEffect {
  return TOOL_EFFECTS[name] ?? "unclassified";
}

/**
 * Shell constructs that change files.
 *
 * A benchmark run made the gap in name-only classification obvious: across 388
 * iterations the agent used edit_file, write_file and create_file four times,
 * and did its real editing through run_terminal — `sed -i`, `cat >> file`,
 * `printf ... > file`. Classifying by tool name alone therefore recorded those
 * edits as verification, which is the opposite of what they are.
 */
const WRITING_COMMANDS = new Set([
  "mv", "cp", "rm", "install", "mkdir", "touch", "truncate", "ln", "tee",
  "patch", "dd", "rsync", "unzip", "tar",
]);

/** Verifiers, keyed by the program invoked. */
const VERIFYING_COMMANDS = new Set([
  "make", "cmake", "ninja", "gradle", "mvn",
  "pytest", "jest", "vitest", "mocha", "rspec", "tox", "nose",
  "tsc", "eslint", "ruff", "flake8", "mypy", "clippy", "shellcheck",
  "gcc", "g++", "cc", "clang", "clang++", "javac", "rustc",
  "pdflatex", "latexmk", "xelatex",
]);

/**
 * Verifiers reached through a runner: `bun test`, `cargo check`, `go build`.
 * Keyed by program, valued by the subcommands that mean "check this works".
 */
const VERIFYING_SUBCOMMANDS: Record<string, Set<string>> = {
  // `run` is included for every runner: a live turn ran `bun run check.ts` to
  // verify a fix and it was not recognised, so the turn was reported as
  // unverified after it had in fact been verified. Whether a `run` is a check
  // is decided from the script name below.
  bun: new Set(["test", "run"]),
  npm: new Set(["test", "run"]),
  pnpm: new Set(["test", "run"]),
  yarn: new Set(["test", "run"]),
  deno: new Set(["test", "check", "lint", "run"]),
  cargo: new Set(["test", "check", "build", "clippy"]),
  go: new Set(["test", "build", "vet"]),
  python: new Set(["-m"]),
  python3: new Set(["-m"]),
  bunx: new Set(["tsc", "eslint", "vitest", "jest"]),
  npx: new Set(["tsc", "eslint", "vitest", "jest"]),
  git: new Set([]),
};

/** Subcommands of `git` that change the working tree. */
const WRITING_GIT = new Set([
  "apply", "checkout", "restore", "reset", "revert", "stash", "clean", "rm", "mv",
]);

/**
 * Replaces quoted runs with a placeholder of the same shape.
 *
 * Without this, `sed -i 's/CC =.*\/CC = gcc/' unix.mak` reads as a compile,
 * because `gcc` appears inside the replacement text. A word only means a
 * command when it is being invoked, not when it is data.
 */
function stripQuoted(command: string): string {
  return command
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');
}

/** Splits a command line into the segments that each invoke a program. */
function segmentsOf(command: string): string[] {
  return stripQuoted(command)
    .split(/\|\||&&|[;|\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** The program a segment invokes, with `cd x &&` and env prefixes skipped. */
function headOf(segment: string): string[] {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  // Skip leading VAR=value assignments and `sudo`/`time` style prefixes.
  while (
    i < tokens.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) ||
      ["sudo", "time", "env", "nohup"].includes(tokens[i]!))
  ) {
    i++;
  }
  return tokens.slice(i).map((token) => token.replace(/^.*\//, ""));
}

export interface CommandEffect {
  /** The command changes files on disk. */
  writes: boolean;
  /** The command checks that something works. */
  verifies: boolean;
}

/**
 * What a shell command does, judged from the command itself.
 *
 * A command can do both — `sed -i s/x/y/ f.c && make` edits and then builds —
 * and the order matters to anything asking whether an edit was checked, so both
 * flags are reported rather than one winning.
 */
/** Program invoked with an inline script rather than a file. */
const INLINE_SCRIPT = /\b(python3?|node|bun|deno|ruby|perl)\b[^|;]*\s-(c|e)\b/;

/**
 * File-writing APIs, matched inside an inline script.
 *
 * Checked against the raw command, before quoted runs are stripped — the whole
 * script lives inside those quotes. Restricted to calls that name a file, so
 * `process.stdout.write` is not mistaken for one.
 */
const INLINE_WRITE =
  /(\bopen\s*\([^)]*['"][wa]|writeFileSync|\bwriteFile\s*\(|\bfs\.write|Bun\.write|write_text|shutil\.(copy|move)|os\.(remove|rename|makedirs|mkdir))/;

export function classifyCommand(command: string): CommandEffect {
  if (!command.trim()) return { writes: false, verifies: false };

  let writes = false;
  let verifies = false;

  // The benchmark run leaned heavily on inline scripts — 110 node and 106
  // python3 invocations — so a file written from inside one is a real edit
  // path, not an edge case.
  if (INLINE_SCRIPT.test(command) && INLINE_WRITE.test(command)) {
    writes = true;
  }

  for (const segment of segmentsOf(command)) {
    // A redirect into a file writes. `2>&1` and `>&2` point at a stream, not a
    // file, and are the usual false positive for a bare `>` match.
    if (/>>?\s*[^&\s>]/.test(segment)) writes = true;

    const [program, subcommand] = headOf(segment);
    if (!program) continue;

    if (WRITING_COMMANDS.has(program)) writes = true;

    // An in-place edit is the flag, not the program: `sed 's/a/b/' f` only
    // prints, while `sed -i` rewrites the file.
    if (
      (program === "sed" || program === "perl" || program === "ruby") &&
      /\s-[a-zA-Z]*i\b/.test(segment)
    ) {
      writes = true;
    }

    if (program === "git" && subcommand && WRITING_GIT.has(subcommand)) {
      writes = true;
    }

    if (VERIFYING_COMMANDS.has(program)) verifies = true;

    const subcommands = VERIFYING_SUBCOMMANDS[program];
    if (subcommands && subcommand && subcommands.has(subcommand)) {
      // `npm run` only verifies when the script is a check of some kind.
      if (subcommand === "run") {
        verifies = /\b(test|lint|build|check|typecheck)\b/.test(segment);
      } else if (subcommand === "-m") {
        verifies = /-m\s+(pytest|unittest|mypy|ruff|flake8)\b/.test(segment);
      } else {
        verifies = true;
      }
    }
  }

  return { writes, verifies };
}

/** The argument a shell tool carries its command in. */
export function commandOf(args: Record<string, unknown>): string {
  for (const key of ["command", "cmd", "script"]) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return "";
}
