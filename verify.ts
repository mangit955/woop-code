#!/usr/bin/env bun

/**
 * The gate a change passes before it becomes a commit.
 *
 *   bun run verify                     # the working tree, mid-change
 *   bun run verify --staged            # what is staged: the pre-commit hook
 *   bun run verify --all               # every check, regardless of what changed
 *   bun ./verify.ts --commit-msg FILE  # the message rule: the commit-msg hook
 *   bun ./verify.ts --hook             # a Claude Code PreToolUse call, on stdin
 *
 * `bun test`, `tsc --noEmit` and `docs:check` were already the three gates, in
 * CI and in CONTRIBUTING.md's checklist, and they cost about nine seconds
 * together. They were also purely advisory: main went red because a line in
 * CLAUDE.md named a directory that had been renamed, and nothing between the
 * edit and the push ever ran the check that says so. This is that something.
 *
 * Two families of rule.
 *
 * Gate rules pick which checks a change owes, from the paths it touched:
 *
 *   *.ts, *.tsx                     tsc --noEmit, then bun test
 *   tools/, commands/slash/,        extract --check — these are what
 *     runtime/, config/version.ts     site/scripts/extract.ts reads, so a
 *                                     change here can stale surface.json
 *   *.md                            the docs lint
 *
 * The test run is not narrowed to the files that changed. A tools/ edit breaks
 * packages/tests/runtime/ often enough that a narrowed suite would be a suite
 * that lies.
 *
 * Content rules read the diff rather than the file, and only its added lines.
 * A rule that judged whole files would be a rule about the past: forty files
 * import writeFileSync from "fs" today and none of them are the mistake this
 * is looking for. What is being added is the only thing anyone can still fix.
 *
 *   conflict markers      a line git left behind, committed as source
 *   secrets               a staged .env, or a key shape in an added line
 *   silenced tests        an added .only or .skip — a suite that went green
 *                           by quietly not running something
 *   node over bun         readFile/writeFile from fs, child_process, or a
 *                           package AGENTS.md rules out. Not a blanket node:fs
 *                           ban: existsSync and node:path are correct here and
 *                           used throughout. AGENTS.md named the pair, not the
 *                           module.
 *
 * And the message itself has to say what the commit did, in the conventional
 * form CONTRIBUTING.md documents. "updated claude.md context" is the subject
 * of the commit that broke main.
 *
 * Checks run cheapest first, so a typo fails in milliseconds instead of after
 * the suite.
 */

const ROOT = new URL(".", import.meta.url).pathname;

interface Problem {
  /** Repository-relative, or the check's own name when it has no one file. */
  file: string;
  line: number;
  message: string;
}

const problems: Problem[] = [];

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function git(...args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  return new TextDecoder().decode(result.stdout);
}

/** Paths the change touches, deleted ones dropped: they have nothing to check. */
function changedPaths(staged: boolean): string[] {
  const args = ["diff", "--name-only", "--diff-filter=d"];
  if (staged) args.push("--cached");

  const tracked = git(...args)
    .split("\n")
    .filter((path) => path !== "");

  // Untracked files are part of an unstaged change too — a new tool that has
  // never been added is exactly the file worth type checking.
  const untracked = staged
    ? []
    : git("ls-files", "--others", "--exclude-standard")
        .split("\n")
        .filter((path) => path !== "");

  return [...new Set([...tracked, ...untracked])];
}

interface AddedLine {
  file: string;
  /** Line number in the file after the change, for an editor to jump to. */
  line: number;
  text: string;
}

/**
 * Every line the change adds, with where it lands.
 *
 * --unified=0 so the hunks carry no context: a line that was already there is
 * not this change's to answer for.
 */
function addedLines(staged: boolean): AddedLine[] {
  const args = ["diff", "--unified=0", "--diff-filter=d", "--no-color"];
  if (staged) args.push("--cached");

  const added: AddedLine[] = [];
  let file = "";
  let line = 0;

  for (const text of git(...args).split("\n")) {
    if (text.startsWith("+++ b/")) {
      file = text.slice("+++ b/".length);
      continue;
    }

    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }

    if (text.startsWith("+")) {
      added.push({ file, line, text: text.slice(1) });
      line++;
    }
  }

  return added;
}

/**
 * A file git has never seen produces no diff, so it is read whole: every line
 * of it is a line this change is adding. Only in working-tree mode — nothing
 * untracked can be part of a commit.
 */
async function untrackedLines(): Promise<AddedLine[]> {
  const added: AddedLine[] = [];

  for (const file of git("ls-files", "--others", "--exclude-standard")
    .split("\n")
    .filter((path) => path !== "")) {
    const source = Bun.file(ROOT + file);
    if (!(await source.exists())) continue;

    (await source.text()).split("\n").forEach((text, index) => {
      added.push({ file, line: index + 1, text });
    });
  }

  return added;
}

// ---------------------------------------------------------------------------
// content rules
// ---------------------------------------------------------------------------

/** A line git left behind after a conflict, committed as if it were source. */
const CONFLICT = /^(<{7}|={7}|>{7})(\s|$)/;

/** Key shapes worth stopping. Narrow on purpose: a false positive here blocks a commit. */
const SECRETS: Array<[RegExp, string]> = [
  [/AIza[0-9A-Za-z_-]{35}/, "a Google API key"],
  [/\bsk-[A-Za-z0-9]{20,}/, "an OpenAI-style secret key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
];

/** A test that stopped running, or stopped letting anything else run. */
const SILENCED = /\b(?:test|describe|it)\.(only|skip|todo|failing)\b/;

/**
 * Node where Bun has its own, per AGENTS.md. The read/write pair only — the
 * sync helpers and node:path are the right call and are everywhere already.
 */
const NODE_OVER_BUN: Array<[RegExp, string]> = [
  [
    /import\s*\{[^}]*\b(?:readFile|writeFile|appendFile)\b[^}]*\}\s*from\s*["'](?:node:)?fs\/promises["']/,
    "reads or writes through node:fs/promises — use Bun.file / Bun.write",
  ],
  [
    /from\s*["'](?:node:)?child_process["']/,
    "spawns through child_process — use Bun.$ or Bun.spawn",
  ],
  [
    /from\s*["'](?:execa|express|ws|dotenv|better-sqlite3|pg|ioredis|jest|vitest)["']/,
    "imports a package AGENTS.md rules out — Bun has this built in",
  ],
];

function checkContent(added: AddedLine[]) {
  for (const { file, line, text } of added) {
    if (CONFLICT.test(text)) {
      problems.push({
        file,
        line,
        message: "conflict marker — the merge was never finished",
      });
      continue;
    }

    for (const [pattern, what] of SECRETS) {
      if (pattern.test(text)) {
        problems.push({ file, line, message: `looks like ${what}` });
      }
    }

    if (/\.test\.tsx?$/.test(file)) {
      const silenced = text.match(SILENCED);
      if (silenced) {
        problems.push({
          file,
          line,
          message: `.${silenced[1]} — the suite would go green without running this`,
        });
      }
    }

    if (/\.tsx?$/.test(file)) {
      for (const [pattern, why] of NODE_OVER_BUN) {
        if (pattern.test(text)) {
          problems.push({ file, line, message: why });
        }
      }
    }
  }
}

/**
 * A secret is worth stopping whether or not it is on a line: the file itself
 * is one. .env is ignored, so this only fires on `git add -f`.
 */
function checkStagedFiles(paths: string[]) {
  for (const path of paths) {
    const name = path.split("/").pop() ?? path;
    if (name === ".env" || name.startsWith(".env.")) {
      problems.push({
        file: path,
        line: 1,
        message: "environment file — it holds credentials and is gitignored for that reason",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// gate rules
// ---------------------------------------------------------------------------

interface Gate {
  name: string;
  cmd: string[];
  /** True when a path this change touched makes the gate apply. */
  applies(path: string): boolean;
}

/** What site/scripts/extract.ts imports, and so what can stale surface.json. */
const EXTRACT_SOURCES = [
  "tools/",
  "commands/slash/",
  "runtime/",
  "config/version.ts",
];

const GATES: Gate[] = [
  {
    name: "docs lint",
    cmd: ["bun", "./site/scripts/check-docs.ts"],
    applies: (path) => path.endsWith(".md"),
  },
  {
    name: "docs surface",
    cmd: ["bun", "./site/scripts/extract.ts", "--check"],
    applies: (path) => EXTRACT_SOURCES.some((source) => path.startsWith(source)),
  },
  {
    name: "type check",
    cmd: ["bunx", "--no-install", "tsc", "--noEmit"],
    applies: (path) => /\.tsx?$/.test(path),
  },
  {
    name: "tests",
    cmd: ["bun", "test"],
    applies: (path) => /\.tsx?$/.test(path),
  },
];

/** Runs a gate, showing its output only when it fails: a passing gate is one line. */
async function runGate(gate: Gate): Promise<boolean> {
  const started = Date.now();
  const child = Bun.spawn({
    cmd: gate.cmd,
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (code === 0) {
    console.log(`  ok    ${gate.name}  ${seconds}s`);
    return true;
  }

  console.log(`  FAIL  ${gate.name}  ${seconds}s  (${gate.cmd.join(" ")})`);
  const output = (out + err).trimEnd();
  if (output) console.log(output.replace(/^/gm, "        "));
  return false;
}

// ---------------------------------------------------------------------------
// the commit message
// ---------------------------------------------------------------------------

const TYPES = [
  "feat",
  "fix",
  "docs",
  "test",
  "refactor",
  "perf",
  "chore",
  "style",
  "build",
  "ci",
];

const CONVENTIONAL = new RegExp(`^(${TYPES.join("|")})(\\([\\w./-]+\\))?!?: .+`);

/** Subjects git writes itself, or that say plainly they are not the final message. */
const EXEMPT = /^(Merge |Revert |Reapply |fixup!|squash!|amend!)/;

async function checkCommitMessage(path: string): Promise<number> {
  const source = await Bun.file(path).text();
  const subject =
    source
      .split("\n")
      .find((line) => line.trim() !== "" && !line.startsWith("#")) ?? "";

  if (subject === "" || EXEMPT.test(subject)) return 0;
  if (CONVENTIONAL.test(subject)) return 0;

  console.error(
    [
      `\nThe commit message does not say what the commit did.\n`,
      `  ${subject}\n`,
      `Use the conventional form CONTRIBUTING.md documents:\n`,
      `  type(scope): what changed, in the imperative\n`,
      `  types: ${TYPES.join(", ")}\n`,
      `For example:\n`,
      `  fix(runtime): keep batched tool calls in the turn that produced them\n`,
    ].join("\n"),
  );

  return 1;
}

// ---------------------------------------------------------------------------
// modes
// ---------------------------------------------------------------------------

/** Runs the rules over a change and reports. Returns the process exit code. */
async function verify(options: { staged: boolean; all: boolean }): Promise<number> {
  const paths = options.all ? [] : changedPaths(options.staged);

  if (!options.all && paths.length === 0) {
    console.log("verify: nothing to check.");
    return 0;
  }

  if (!options.all) {
    checkStagedFiles(paths);
    checkContent(addedLines(options.staged));
    if (!options.staged) checkContent(await untrackedLines());
  }

  for (const problem of problems) {
    console.log(`error  ${problem.file}:${problem.line}  ${problem.message}`);
  }

  // The gates are the expensive half, and a conflict marker is not going to
  // pass them. Report what is already known rather than spend nine seconds
  // arriving at the same answer.
  if (problems.length > 0) {
    console.log(
      `\n${problems.length} problem(s) in the change itself; gates not run.`,
    );
    return 1;
  }

  const gates = options.all
    ? GATES
    : GATES.filter((gate) => paths.some((path) => gate.applies(path)));

  if (gates.length === 0) {
    console.log(
      `verify: ${paths.length} file(s) changed, no gate applies to them.`,
    );
    return 0;
  }

  const scope = options.all ? "everything" : `${paths.length} changed file(s)`;
  console.log(`verify: ${scope}`);

  let failed = 0;
  for (const gate of gates) {
    if (!(await runGate(gate))) failed++;
  }

  console.log(
    failed === 0
      ? `\n${gates.length} gate(s) passed.`
      : `\n${failed} of ${gates.length} gate(s) failed.`,
  );

  return failed === 0 ? 0 : 1;
}

/**
 * A Claude Code PreToolUse call, arriving as JSON on stdin.
 *
 * Git hooks are local configuration and --no-verify walks past them, so this is
 * the second lock on the same door: the agent's own `git commit` is gated even
 * where the hook was never installed. Exit 2 is what blocks the call and hands
 * the reason back, so everything else — a command that is not a commit, stdin
 * that will not parse — has to exit 0 and get out of the way.
 */
async function hook(): Promise<number> {
  let command = "";

  try {
    const payload = JSON.parse(await Bun.stdin.text());
    command = String(payload?.tool_input?.command ?? "");
  } catch {
    return 0;
  }

  if (!/(^|[;&|]\s*)git\s+(-\S+\s+|--\S+(=\S+)?\s+)*commit\b/.test(command)) {
    return 0;
  }

  // Quoted text is the message, not the flags. `-m "handle the -n case"` is a
  // commit worth allowing, and reading it as a bypass would block one.
  const flags = command.replace(/"[^"]*"|'[^']*'/g, '""');

  if (/--no-verify\b|(^|\s)-[a-zA-Z]{0,3}n[a-zA-Z]{0,3}(\s|$)/.test(flags)) {
    console.error(
      "Blocked: --no-verify skips the validation gate. Run `bun run verify --staged`, " +
        "fix what it reports, and commit without the flag.",
    );
    return 2;
  }

  const code = await verify({ staged: true, all: false });
  if (code === 0) return 0;

  console.error(
    "Blocked: the staged change does not pass `bun run verify --staged` (output above). " +
      "Fix what it reports, then commit.",
  );
  return 2;
}

const args = Bun.argv.slice(2);
const messageAt = args.indexOf("--commit-msg");

let exitCode: number;

if (messageAt !== -1) {
  const path = args[messageAt + 1];
  if (!path) {
    console.error("--commit-msg needs the path to the message file");
    exitCode = 1;
  } else {
    exitCode = await checkCommitMessage(path);
  }
} else if (args.includes("--hook")) {
  exitCode = await hook();
} else {
  exitCode = await verify({
    staged: args.includes("--staged"),
    all: args.includes("--all"),
  });
}

process.exit(exitCode);
