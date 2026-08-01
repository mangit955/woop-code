/**
 * Checks every page in `docs/` against the contracts in site/design/system.md.
 *
 *   bun run docs:lint
 *
 * The design system is prose, and prose is not enforceable — a rule that lives
 * only in a document is a rule that gets forgotten by page forty. These are the
 * rules narrow enough to check mechanically:
 *
 *   error   missing or invalid frontmatter (§7 — the page type is a contract)
 *   error   a heading deeper than h3 (§3)
 *   error   an unresolved {{...}} placeholder (§8 rule 3)
 *   warn    a fenced line long enough to wrap in the content column
 *
 * The last one is a warning rather than an error because wrapping is the
 * designed behaviour, not a failure: code and terminal output wrap and never
 * scroll sideways. It exists so a capture that will wrap is a decision someone
 * made, not a surprise they discover in the browser.
 */

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

const DOCS = new URL("../../docs/", import.meta.url).pathname;
const problems: Problem[] = [];

function check(file: string, source: string) {
  const { data, body } = parseFrontmatter(source);

  // ── Frontmatter ──────────────────────────────────────────────────────
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

  // ── Counts in prose ──────────────────────────────────────────────────
  //
  // Rule 3 in system.md §8: never document what the code can generate. A count
  // typed out in prose is stale the moment someone adds a tool — which is
  // exactly how "13 tools" ended up in README.md.
  //
  // Checked against the *raw* body, before substitution: a line that already
  // uses a placeholder is correct, and after substitution it looks identical to
  // one that was typed by hand. Digits only, because "one command" is English
  // rather than a count, and only for the nouns the extractor actually knows.
  body.split("\n").forEach((text, index) => {
    if (text.includes("{{")) return;

    const counted = text.match(
      /\b\d[\d,]*\s+(tools?|slash commands?|approval modes?|providers?)\b/i,
    );

    if (counted) {
      problems.push({
        file,
        line: offset + index,
        level: "error",
        message: `"${counted[0]}" is a count in prose — use a {{...}} placeholder or rephrase`,
      });
    }
  });

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
      problems.push({
        file,
        line,
        level: "error",
        message: unresolved[0],
      });
    }
  });
}

const glob = new Bun.Glob("**/*.md");
let count = 0;

for await (const entry of glob.scan(DOCS)) {
  count += 1;
  check(entry, await Bun.file(DOCS + entry).text());
}

const errors = problems.filter((problem) => problem.level === "error");
const warnings = problems.filter((problem) => problem.level === "warn");

for (const problem of problems) {
  const label = problem.level === "error" ? "error" : " warn";
  console.log(`${label}  docs/${problem.file}:${problem.line}  ${problem.message}`);
}

console.log(
  `\n${count} page(s), ${errors.length} error(s), ${warnings.length} warning(s)`,
);

if (errors.length > 0) process.exit(1);
