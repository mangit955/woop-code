/**
 * Checks the repository's Markdown against the contracts in site/design/system.md.
 *
 *   bun run docs:lint
 *
 * The design system is prose, and prose is not enforceable — a rule that lives
 * only in a document is a rule that gets forgotten by page forty. These are the
 * rules narrow enough to check mechanically.
 *
 * Two sets, because they answer to different things:
 *
 *   Site pages (`docs/` only) are rendered, so they owe the renderer a shape:
 *     error   missing or invalid frontmatter (§7 — the page type is a contract)
 *     error   a heading deeper than h3 (§3)
 *     error   an unresolved {{...}} placeholder (§8 rule 3)
 *     warn    a fenced line long enough to wrap in the content column
 *
 *   Every tracked Markdown file owes the reader the truth:
 *     error   a count typed out in prose (§8 rule 3)
 *     error   an absolute path from somebody's machine
 *     error   a repository path that does not exist
 *
 * The second set used to be scoped to `docs/` too, and packages/tests/ drifted
 * exactly as rule 3 predicts while this check passed beside it every run: stale
 * counts, a `cd /Users/...`, and instructions pointing at three directories that
 * had been deleted. A rule that only applies to one directory is how a file
 * escapes it.
 */

import { existsSync } from "node:fs";
import { parseFrontmatter, substitute } from "../src/docs/render";

/** The content column at its widest, in monospace characters at 14px. */
const COLUMN = 78;

const TYPES = new Set(["concept", "guide", "reference"]);

interface Problem {
  file: string;
  line: number;
  level: "error" | "warn";
  message: string;
}

const ROOT = new URL("../../", import.meta.url).pathname;
const problems: Problem[] = [];

/**
 * Nouns whose totals the code already knows. Digits only, because "one command"
 * is English rather than a count.
 */
const COUNTED =
  /\b\d[\d,]*\s+(tools?|slash commands?|approval modes?|providers?|tests?|test files?|assertions?)\b/i;

/** Somebody's home directory, which is true on exactly one machine. */
const MACHINE_PATH = /(?:^|[\s`"'(])(\/Users\/[\w.-]+|\/home\/[\w.-]+)\//;

/**
 * Directories a path has to start with to be read as a claim about this
 * repository. Anything else — a URL, an example path in a user's own project,
 * /etc/hosts — is prose about the world rather than about the tree.
 */
const REPO_DIRS = [
  "packages/",
  "tools/",
  "runtime/",
  "config/",
  "commands/",
  "tui/",
  "site/",
  "docs/",
  "onboarding/",
  ".github/",
];

/**
 * The design system is where these rules are written down, and writing a rule
 * down means quoting what breaks it. Linting the rulebook with its own rule only
 * ever finds the examples.
 */
const RULEBOOK = "site/design/";

/** Rules every tracked Markdown file answers to. */
function checkProse(file: string, body: string, offset: number) {
  body.split("\n").forEach((text, index) => {
    const line = offset + index;

    // A fence's info string names the file a snippet *would* live in — often one
    // the reader is being walked through creating. The body of the fence is
    // still checked; it is the commands there that go stale.
    if (/^\s*```/.test(text)) return;

    // Checked against the raw body, before substitution: a line that already
    // uses a placeholder is correct, and after substitution it looks identical
    // to one that was typed by hand.
    if (!text.includes("{{")) {
      const counted = text.match(COUNTED);
      if (counted) {
        problems.push({
          file,
          line,
          level: "error",
          message: `"${counted[0].trim()}" is a count in prose — use a {{...}} placeholder or rephrase`,
        });
      }
    }

    const machine = text.match(MACHINE_PATH);
    if (machine) {
      problems.push({
        file,
        line,
        level: "error",
        message: `"${machine[1]}" is a path from one machine — use a relative path`,
      });
    }

    for (const path of repoPaths(text)) {
      if (existsSync(ROOT + path)) continue;
      problems.push({
        file,
        line,
        level: "error",
        message: `"${path}" does not exist — the tree moved on without this line`,
      });
    }
  });
}

/**
 * Paths in a line that claim to point somewhere in this repository.
 *
 * Only those under a known top-level directory are considered, so a glob, a URL
 * or an example from somebody else's project is left alone.
 */
function repoPaths(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(/[\w./-]*[\w-]\/[\w./-]*/g)) {
    const raw = match[0];
    if (raw.includes("*") || raw.includes("://")) continue;

    const path = raw.replace(/[.,:;)]+$/, "").replace(/\/$/, "");
    if (!REPO_DIRS.some((dir) => path.startsWith(dir))) continue;

    found.add(path);
  }

  return [...found];
}

/** Rules only a rendered site page answers to. */
function checkSitePage(file: string, source: string) {
  const { data, body } = parseFrontmatter(source);

  if (!data.title) {
    problems.push({ file, line: 1, level: "error", message: "missing `title`" });
  }

  if (!data.type) {
    problems.push({ file, line: 1, level: "error", message: "missing `type`" });
  } else if (!TYPES.has(data.type)) {
    problems.push({
      file,
      line: 1,
      level: "error",
      message: `\`type: ${data.type}\` is not one of ${[...TYPES].join(", ")}`,
    });
  }

  if (!data.summary) {
    problems.push({
      file,
      line: 1,
      level: "error",
      message: "missing `summary` — it is what search results and cards show",
    });
  }

  // Frontmatter is stripped before the body is scanned, so line numbers have to
  // be offset back to the real file.
  const offset = source.slice(0, source.length - body.length).split("\n").length;
  const lines = substitute(body).split("\n");

  let inFence = false;

  lines.forEach((text, index) => {
    const line = offset + index;

    if (/^\s*```/.test(text)) {
      inFence = !inFence;
      return;
    }

    if (inFence) {
      if (text.length > COLUMN) {
        problems.push({
          file,
          line,
          level: "warn",
          message: `fenced line is ${text.length} chars; wraps past ${COLUMN}`,
        });
      }
      return;
    }

    if (/^#{4,}\s/.test(text)) {
      problems.push({
        file,
        line,
        level: "error",
        message: "heading deeper than h3 — use a table or a new page",
      });
    }

    const unresolved = text.match(/⚠ unresolved: \{\{[^}]+\}\}|⚠ unknown tool: \S+/);
    if (unresolved) {
      problems.push({ file, line, level: "error", message: unresolved[0] });
    }
  });
}

/** Every Markdown file git knows about: tracked, so never node_modules. */
function trackedMarkdown(): string[] {
  const result = Bun.spawnSync({
    cmd: ["git", "ls-files", "-z", "--", "*.md"],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "ignore",
  });

  return new TextDecoder()
    .decode(result.stdout)
    .split("\0")
    .filter((path) => path !== "" && !path.startsWith("site/dist/"));
}

const files = trackedMarkdown();

for (const file of files) {
  const source = await Bun.file(ROOT + file).text();

  if (file.startsWith("docs/")) {
    checkSitePage(file.slice("docs/".length), source);
    const { body } = parseFrontmatter(source);
    const offset = source.slice(0, source.length - body.length).split("\n").length;
    checkProse(file.slice("docs/".length), body, offset);
  } else if (!file.startsWith(RULEBOOK)) {
    checkProse(file, source, 1);
  }
}

const errors = problems.filter((problem) => problem.level === "error");
const warnings = problems.filter((problem) => problem.level === "warn");

for (const problem of problems) {
  const label = problem.level === "error" ? "error" : " warn";
  console.log(`${label}  ${problem.file}:${problem.line}  ${problem.message}`);
}

console.log(
  `\n${files.length} file(s), ${errors.length} error(s), ${warnings.length} warning(s)`,
);

if (errors.length > 0) process.exit(1);
