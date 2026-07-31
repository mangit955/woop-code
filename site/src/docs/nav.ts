/**
 * The information architecture, declared.
 *
 * Order matters and cannot be derived — alphabetical would put "Reference"
 * before "Getting started", and a directory listing has no opinion about
 * whether approval modes come before reviewing diffs. So the tree is written
 * out here, and the renderer checks it against what actually exists in `docs/`.
 *
 * Two rules from site/design/system.md that this file enforces:
 *
 *  - **Two levels, never three.** A section holds pages; a page may hold
 *    children only where the children are instances of one thing (the tools).
 *    Anything wanting a third level is a table on a page, not a nav entry.
 *
 *  - **Configuration appears once.** It is Reference — keys, types, defaults.
 *    Its task-shaped counterpart is the "Configuring providers" guide. Two
 *    entries with the same name is the ambiguity that makes people give up on
 *    navigation and use search instead.
 *
 * Pages listed here that have no markdown file yet render as `planned`: visible
 * in the nav, greyed, not a link. That keeps the shape of the docs honest while
 * they are being written, rather than shipping a sidebar full of 404s.
 */

export interface NavEntry {
  /** Site path, without `/docs`. Matches the file path under `docs/`. */
  slug: string;
  title: string;
  children?: NavEntry[];
}

export interface NavSection {
  title: string;
  entries: NavEntry[];
}

export const NAV: NavSection[] = [
  {
    title: "Introduction",
    entries: [
      { slug: "introduction/what-is-woopcode", title: "What Woopcode is" },
      { slug: "introduction/why", title: "Why use it" },
      { slug: "introduction/how-a-turn-works", title: "How a turn works" },
    ],
  },
  {
    title: "Getting started",
    entries: [
      { slug: "getting-started/install", title: "Install" },
      { slug: "getting-started/first-session", title: "Your first session" },
      { slug: "getting-started/connect-a-provider", title: "Connect a provider" },
    ],
  },
  {
    title: "Guides",
    entries: [
      // Safety leads. It is not a top-level section — that was a category error
      // — but it is the first thing a reader meets after the quickstart, and
      // the quickstart links here at the moment they first see a diff.
      { slug: "guides/approval-modes", title: "Approval modes" },
      { slug: "guides/reviewing-diffs", title: "Reviewing diffs" },
      { slug: "guides/working-in-a-repository", title: "Working in a repository" },
      { slug: "guides/sessions-and-history", title: "Sessions & history" },
      { slug: "guides/configuring-providers", title: "Configuring providers" },
    ],
  },
  {
    title: "Reference",
    entries: [
      { slug: "reference/cli", title: "CLI" },
      { slug: "reference/slash-commands", title: "Slash commands" },
      {
        slug: "reference/tools",
        title: "Tools",
        // The one place a third level is allowed: these are instances of a
        // single kind, generated from the registry, not a nested taxonomy.
        children: [
          { slug: "reference/tools/read-file", title: "read_file" },
        ],
      },
      { slug: "reference/configuration", title: "Configuration" },
      { slug: "reference/keyboard", title: "Keyboard" },
    ],
  },
  {
    title: "Architecture",
    entries: [
      { slug: "architecture/how-it-works", title: "How it works" },
      { slug: "architecture/running-from-source", title: "Running from source" },
      { slug: "architecture/adding-a-tool", title: "Adding a tool" },
    ],
  },
];

/** Every entry, depth-first, in reading order. Prev/next walks this. */
export function flatten(sections: NavSection[] = NAV): NavEntry[] {
  const out: NavEntry[] = [];

  for (const section of sections) {
    for (const entry of section.entries) {
      out.push(entry);
      if (entry.children) out.push(...entry.children);
    }
  }

  return out;
}

/** The section an entry belongs to, for breadcrumbs. */
export function sectionOf(slug: string): NavSection | undefined {
  return NAV.find((section) =>
    section.entries.some(
      (entry) =>
        entry.slug === slug ||
        entry.children?.some((child) => child.slug === slug),
    ),
  );
}

export function titleOf(slug: string): string | undefined {
  return flatten().find((entry) => entry.slug === slug)?.title;
}
