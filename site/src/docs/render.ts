/**
 * The docs renderer.
 *
 * Markdown in `docs/`, rendered on request. Deliberately outside the React app
 * and outside the bundler: a prose edit is visible on reload with no build
 * step, and the docs' tokens cannot leak into the landing page.
 *
 * What this file owns: frontmatter, the substitutions that come from the code
 * rather than the writer, heading anchors, the on-page table of contents, and
 * the page shell — sidebar, breadcrumbs, prev/next.
 *
 * See site/design/system.md for the rules it implements.
 */

import surface from "./surface.json";
// Read live rather than from surface.json: VERSION derives from package.json,
// so a release bump reaches the docs without regenerating anything.
import { VERSION } from "../../../config/version";
import {
  renderMarkdown,
  escapeHtml as escape,
  type Heading,
} from "./markdown";
import { NAV, flatten, sectionOf, titleOf, type NavEntry } from "./nav";
import { pageExists, pageSource } from "./pages";

const DOCS_ROOT = new URL("../../../docs/", import.meta.url);

export interface Frontmatter {
  title?: string;
  type?: "concept" | "guide" | "reference";
  summary?: string;
  since?: string;
  prerequisites?: string[];
  related?: string[];
}

/**
 * A deliberately small YAML subset: `key: value` and `- item` lists. Enough for
 * the frontmatter contract in system.md §7, and no dependency. If a page needs
 * more than this, the contract has grown and should be reconsidered rather than
 * the parser extended.
 */
export function parseFrontmatter(source: string): {
  data: Frontmatter;
  body: string;
} {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: source };

  const data: Record<string, string | string[]> = {};
  let currentKey: string | null = null;

  for (const line of match[1]!.split(/\r?\n/)) {
    const item = line.match(/^\s*-\s+(.*)$/);

    if (item && currentKey) {
      (data[currentKey] as string[]).push(item[1]!.trim());
      continue;
    }

    const pair = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!pair) continue;

    const [, key, value] = pair as unknown as [string, string, string];

    if (value.trim() === "") {
      // A key with nothing after it opens a list.
      currentKey = key;
      data[key] = [];
    } else {
      currentKey = null;
      data[key] = value.trim();
    }
  }

  return { data: data as Frontmatter, body: source.slice(match[0].length) };
}

// ─── Substitution ───────────────────────────────────────────────────────────

/** Markdown table of the approval modes, straight from `APPROVAL_MODES`. */
function approvalModesTable(): string {
  const rows = surface.approvalModes.map((mode) => {
    const notes = [
      mode.default ? "Default" : "",
      mode.unsafe ? "**Unsafe**" : "",
    ]
      .filter(Boolean)
      .join(" · ");

    return `| \`${mode.mode}\` | ${mode.label} | ${mode.description} | ${notes || "—"} |`;
  });

  return [
    "| Mode | Label | What runs without asking | Notes |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** Every slash command, grouped the way the registry groups them. */
function slashCommandsTable(category?: string): string {
  const commands = category
    ? surface.commands.filter((command) => command.category === category)
    : surface.commands;

  const rows = commands.map((command) => {
    const aliases = command.aliases.length
      ? command.aliases.map((alias) => `\`/${alias}\``).join(", ")
      : "—";

    return `| \`/${command.name}\` | ${aliases} | ${command.description} |`;
  });

  if (rows.length === 0) return `> No commands in \`${category}\`.`;

  return ["| Command | Aliases | Description |", "| --- | --- | --- |", ...rows].join(
    "\n",
  );
}

/**
 * Every tool, with what it is allowed to do. The effect column is the reason
 * this table exists: it is the answer to "which of these can change my files",
 * and it should never be maintained by hand.
 */
function toolsTable(effect?: string): string {
  const tools = effect
    ? surface.tools.filter((tool) => tool.effect === effect)
    : surface.tools;

  const rows = tools.map(
    (tool) => `| \`${tool.name}\` | ${tool.description} | ${tool.gate} |`,
  );

  if (rows.length === 0) return `> No tools with effect \`${effect}\`.`;

  return ["| Tool | What it does | Approval |", "| --- | --- | --- |", ...rows].join(
    "\n",
  );
}

/** Markdown parameter table for one tool, straight from its registry entry. */
function toolParameters(name: string): string {
  const tool = surface.tools.find((entry) => entry.name === name);
  if (!tool) return `> Unknown tool \`${name}\`.`;

  if (tool.parameters.length === 0) return "This tool takes no parameters.";

  const rows = tool.parameters.map(
    (parameter) =>
      `| \`${parameter.name}\` | \`${parameter.type}\` | ${
        parameter.required ? "Yes" : "No"
      } | ${parameter.description} |`,
  );

  return [
    "| Parameter | Type | Required | Description |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/**
 * Replaces `{{...}}` with values the code owns.
 *
 * Rule 3 in system.md §8: nothing in `docs/` states a count, a parameter, a
 * command name, or a mode description in prose. An unknown placeholder is left
 * visible rather than silently blanked — a wrong number that looks right is the
 * failure this whole mechanism exists to prevent.
 */
export function substitute(body: string): string {
  return body.replace(/\{\{([^}]+)\}\}/g, (whole, expression: string) => {
    const key = expression.trim();

    if (key === "version") return VERSION;
    if (key === "counts.tools") return String(surface.counts.tools);
    if (key === "counts.commands") return String(surface.counts.commands);
    if (key === "counts.approvalModes") {
      return String(surface.counts.approvalModes);
    }
    if (key === "approval-modes-table") return approvalModesTable();
    if (key === "slash-commands-table") return slashCommandsTable();
    if (key === "tools-table") return toolsTable();

    const slash = key.match(/^slash-commands-table:(\w+)$/);
    if (slash) return slashCommandsTable(slash[1]);

    const tools = key.match(/^tools-table:(\w+)$/);
    if (tools) return toolsTable(tools[1]);

    const tool = key.match(/^tool:([a-z_]+):(description|gate|params)$/);
    if (tool) {
      const [, name, field] = tool as unknown as [string, string, string];
      const entry = surface.tools.find((candidate) => candidate.name === name);

      if (!entry) return `⚠ unknown tool: ${name}`;
      if (field === "params") return toolParameters(name);
      if (field === "gate") return entry.gate;
      return entry.description;
    }

    return `⚠ unresolved: ${whole}`;
  });
}

// ─── Navigation ─────────────────────────────────────────────────────────────

async function exists(slug: string): Promise<boolean> {
  return pageExists(slug);
}

/**
 * The sidebar.
 *
 * An entry with no markdown file yet renders as `planned` — visible, greyed,
 * not a link. The shape of the docs stays honest while they are being written
 * instead of the sidebar filling up with 404s.
 */
async function sidebar(current: string): Promise<string> {
  const groups = await Promise.all(
    NAV.map(async (section) => {
      const items = await Promise.all(
        section.entries.map(async (entry) => renderNavItem(entry, current)),
      );

      return `<div class="nav-group">
        <p class="nav-group__label">${escape(section.title)}</p>
        <ul class="nav-list">${items.join("")}</ul>
      </div>`;
    }),
  );

  return `<nav class="sidebar" aria-label="Documentation">
    <div class="sidebar__rail" aria-hidden="true"></div>
    ${groups.join("")}
  </nav>`;
}

async function renderNavItem(
  entry: NavEntry,
  current: string,
): Promise<string> {
  const live = await exists(entry.slug);
  const active = entry.slug === current;

  const label = live
    ? `<a class="nav-link" href="/docs/${entry.slug}"${
        active ? ' aria-current="page"' : ""
      }>${escape(entry.title)}</a>`
    : `<span class="nav-link nav-link--planned" title="Not written yet">${escape(
        entry.title,
      )}</span>`;

  const children = entry.children
    ? await Promise.all(
        entry.children.map((child) => renderNavItem(child, current)),
      )
    : [];

  const nested = children.length
    ? `<ul class="nav-list nav-list--nested">${children.join("")}</ul>`
    : "";

  return `<li class="nav-item">${label}${nested}</li>`;
}

function tableOfContents(headings: Heading[]): string {
  if (headings.length < 2) return "";

  const items = headings
    .map(
      (heading) =>
        `<li class="toc-item toc-item--h${heading.level}">
          <a href="#${heading.id}" data-toc="${heading.id}">${escape(heading.text)}</a>
        </li>`,
    )
    .join("");

  return `<nav class="toc" aria-label="On this page">
    <p class="toc__label">On this page</p>
    <ul class="toc__list">${items}</ul>
  </nav>`;
}

/** Previous and next in reading order, skipping pages that are not written. */
async function pager(current: string): Promise<string> {
  const entries = flatten();
  const index = entries.findIndex((entry) => entry.slug === current);
  if (index === -1) return "";

  const findLive = async (step: -1 | 1) => {
    for (let i = index + step; i >= 0 && i < entries.length; i += step) {
      const entry = entries[i]!;
      if (await exists(entry.slug)) return entry;
    }
    return undefined;
  };

  const [previous, next] = await Promise.all([findLive(-1), findLive(1)]);
  if (!previous && !next) return "";

  const card = (entry: NavEntry | undefined, direction: "Previous" | "Next") =>
    entry
      ? `<a class="pager__card pager__card--${direction.toLowerCase()}" href="/docs/${entry.slug}">
          <span class="pager__direction">${direction}</span>
          <span class="pager__title">${escape(entry.title)}</span>
        </a>`
      : `<span></span>`;

  return `<nav class="pager" aria-label="Pagination">
    ${card(previous, "Previous")}${card(next, "Next")}
  </nav>`;
}

function breadcrumbs(slug: string, title: string): string {
  const section = sectionOf(slug);

  const trail = [
    `<a href="/docs">Docs</a>`,
    section ? `<span>${escape(section.title)}</span>` : "",
    `<span aria-current="page">${escape(title)}</span>`,
  ].filter(Boolean);

  return `<nav class="crumbs" aria-label="Breadcrumb">${trail.join(
    `<span class="crumbs__sep" aria-hidden="true">/</span>`,
  )}</nav>`;
}

// ─── Shell ──────────────────────────────────────────────────────────────────

interface ShellOptions {
  title: string;
  description?: string;
  sidebar: string;
  toc?: string;
  content: string;
}

function shell({
  title,
  description,
  sidebar,
  toc,
  content,
}: ShellOptions): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${escape(title)} — Woopcode docs</title>
    ${description ? `<meta name="description" content="${escape(description)}" />` : ""}
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <!-- Order matters: authored light first, generated dark second. See tokens.css. -->
    <link rel="stylesheet" href="/docs/tokens.css" />
    <link rel="stylesheet" href="/docs/tokens.generated.css" />
    <link rel="stylesheet" href="/docs/layout.css" />
    <link rel="stylesheet" href="/docs/components.css" />
    <script>
      // Before first paint: a saved theme must not flash the other one.
      try {
        var saved = localStorage.getItem("woopcode-theme");
        if (saved) document.documentElement.dataset.theme = saved;
      } catch (e) {}
    </script>
  </head>
  <body>
    <header class="topbar">
      <a class="topbar__brand" href="/">
        <span class="topbar__mark" aria-hidden="true"></span>
        <span class="topbar__name">woopcode</span>
        <span class="topbar__section">docs</span>
      </a>

      <div class="topbar__actions">
        <button class="topbar__menu" type="button" aria-expanded="false"
          aria-controls="sidebar" data-menu>Menu</button>
        <button class="search-trigger" type="button" data-search-open>
          <span>Search</span>
          <kbd class="search-trigger__key">⌘K</kbd>
        </button>
        <span class="topbar__version">v${VERSION}</span>
        <button class="topbar__theme" type="button" data-theme-toggle
          aria-label="Switch between light and dark">Theme</button>
        <a class="topbar__cta" href="https://github.com/mangit955/woop-code"
          target="_blank" rel="noreferrer">GitHub</a>
      </div>
    </header>

    <div class="layout${toc ? "" : " layout--no-toc"}">
      <div class="layout__sidebar" id="sidebar" data-sidebar>${sidebar}</div>
      <main class="layout__main">${content}</main>
      ${toc ? `<div class="layout__toc">${toc}</div>` : ""}
    </div>

    <div class="scrim" data-scrim hidden></div>

    <div class="palette" data-palette hidden>
      <div class="palette__scrim" data-palette-dismiss></div>
      <div class="palette__box" role="dialog" aria-modal="true"
        aria-label="Search documentation">
        <input class="palette__input" type="search" data-palette-input
          placeholder="Search the docs" autocomplete="off" spellcheck="false"
          aria-controls="palette-results" aria-expanded="true" />
        <ul class="palette__results" id="palette-results" role="listbox"
          data-palette-results></ul>
        <p class="palette__hint">
          <kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>↵</kbd> to open ·
          <kbd>esc</kbd> to close
        </p>
      </div>
    </div>

    <script src="/docs/client.js" defer></script>
  </body>
</html>
`;
}

// ─── Pages ──────────────────────────────────────────────────────────────────

/** Renders one docs page, or null when there is no markdown file for the path. */
export async function renderPage(slug: string): Promise<string | null> {
  // Traversal is refused inside pageSource — the same posture as
  // resolveWorkspacePath in the product.
  const source = await pageSource(slug);
  if (source === null) return null;

  const { data, body } = parseFrontmatter(source);
  const { html, headings } = await renderMarkdown(substitute(body));

  const title = data.title ?? titleOf(slug) ?? slug;

  const since = data.since
    ? `<p class="page-since">Added in woopcode@${escape(data.since)}</p>`
    : "";

  const content = `<article class="page">
    ${breadcrumbs(slug, title)}
    ${html}
    ${since}
    ${await pager(slug)}
  </article>`;

  return shell({
    title,
    description: data.summary,
    sidebar: await sidebar(slug),
    toc: tableOfContents(headings),
    content,
  });
}

/**
 * The page someone lands on after a stale link or a typo.
 *
 * Rendered in the full shell rather than as bare text: arriving at a docs site
 * through a broken URL is common — search engines index paths that later move,
 * and people mistype — and the reader still needs the sidebar, the search, and
 * somewhere obvious to go. A plain "Not found" string strands them.
 */
export async function renderNotFound(slug: string): Promise<string> {
  const attempted = slug ? `/docs/${slug}` : "/docs";

  const content = `<article class="page page--notfound">
    <p class="notfound__code">404</p>
    <h1>This page does not exist</h1>
    <p class="lede">Nothing is published at
      <code>${escape(attempted)}</code>. It may have moved, or the link that
      brought you here may be out of date.</p>

    <div class="notfound__actions">
      <button class="notfound__search" type="button" data-search-open>
        Search the docs
      </button>
      <a class="notfound__link" href="/docs">Documentation home</a>
    </div>

    <div class="cards">
      <a class="card" href="/docs/getting-started/install">
        <span class="card__title">Install</span>
        <span class="card__meta">Start here if you are new</span>
      </a>
      <a class="card" href="/docs/getting-started/first-session">
        <span class="card__title">Your first session</span>
        <span class="card__meta">One change, end to end</span>
      </a>
      <a class="card" href="/docs/reference/cli">
        <span class="card__title">CLI</span>
        <span class="card__meta">Every command and flag</span>
      </a>
    </div>
  </article>`;

  return shell({
    title: "Page not found",
    description: "That documentation page does not exist.",
    sidebar: await sidebar(""),
    content,
  });
}

/** The docs home: one card per section, entry points only. */
export async function renderIndex(): Promise<string> {
  const cards = await Promise.all(
    NAV.map(async (section) => {
      // Children count as pages of the section — a Reference with a written
      // tool page is not "0 of 5" — and the card points at the first page that
      // actually exists, which may be one of them.
      const all = section.entries.flatMap((entry) => [
        entry,
        ...(entry.children ?? []),
      ]);
      const written = await Promise.all(all.map((entry) => exists(entry.slug)));

      const count = written.filter(Boolean).length;
      const target = all[written.indexOf(true)];

      const inner = `<span class="card__title">${escape(section.title)}</span>
        <span class="card__meta">${count} of ${all.length} pages</span>`;

      return target
        ? `<a class="card" href="/docs/${target.slug}">${inner}</a>`
        : `<span class="card card--planned">${inner}</span>`;
    }),
  );

  const content = `<article class="page page--home">
    <h1>Woopcode documentation</h1>
    <p class="lede">A terminal-native coding agent that reads the repository you
      are in, shows its work, and pauses on a diff before it changes a line.</p>
    <div class="cards">${cards.join("")}</div>
  </article>`;

  return shell({
    title: "Documentation",
    description:
      "Guides and reference for Woopcode, the terminal-native coding agent.",
    sidebar: await sidebar(""),
    content,
  });
}
