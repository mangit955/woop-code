/**
 * The search index.
 *
 * Built here and served as one JSON file, rather than fetched from a hosted
 * search service. The landing page self-hosts its font and makes no
 * third-party requests; the docs keep that. At this size — twenty pages — the
 * index is small enough that shipping it is cheaper than a network round trip
 * per keystroke would be, and it works offline.
 *
 * Entries are **sections, not pages**. Someone searching "full auto" wants the
 * paragraph about `full-auto`, not the top of a long guide with instructions to
 * scroll. Every entry carries the anchor that lands the reader on it.
 */

import { parseFrontmatter, substitute } from "./render";
import { NAV, sectionOf, titleOf } from "./nav";
import { allSlugs, pageSource } from "./pages";

const DOCS_ROOT = new URL("../../../docs/", import.meta.url);

export interface SearchEntry {
  /** `/docs/...` path, with the heading anchor when the entry is a section. */
  url: string;
  /** The page this belongs to, for grouping results. */
  page: string;
  /** Nav section — Introduction, Guides, Reference… */
  group: string;
  /** Heading text, or the page title for the first entry of a page. */
  title: string;
  /** Plain text, already lowercased. The client matches against this. */
  text: string;
  /** A readable slice of the same text, for the result row. */
  snippet: string;
}

/** Same slug rule as the heading renderer, so anchors line up. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Markdown to something worth matching against.
 *
 * Code is kept: `--no-auto-approve` and `read_file` are exactly the kind of
 * thing people paste into a search box. Table pipes, list bullets, link
 * brackets and directive markers are not, so they go.
 */
function plain(markdown: string): string {
  return markdown
    .replace(/^:::\w*$/gm, "")
    .replace(/^@tab\s+/gm, "")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // Inline HTML — `<kbd>Enter</kbd>` and friends. Stripped before the
    // punctuation pass, which would otherwise eat the `>` and leave `<kbd`
    // stranded in the snippet.
    .replace(/<\/?[a-z][^>]*>/gi, "")
    // A table's separator row is punctuation, not content, and it is the first
    // thing that shows up in a snippet for any reference page.
    .replace(/^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/gm, "")
    .replace(/[|>#*_`]/g, " ")
    .replace(/^\s*[-+]\s+/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snippetOf(text: string): string {
  return text.length > 180 ? `${text.slice(0, 180).trimEnd()}…` : text;
}

/**
 * Splits a page into its sections.
 *
 * The text before the first `##` belongs to the page entry; everything after a
 * heading belongs to that heading, up to the next one. Only h2 and h3 open a
 * section — the same depth the table of contents uses, so a search result and
 * a ToC entry point at the same thing.
 */
function sections(body: string): Array<{ heading?: string; text: string }> {
  const out: Array<{ heading?: string; text: string }> = [];
  let current: { heading?: string; lines: string[] } = { lines: [] };
  let inFence = false;

  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;

    const heading = !inFence && line.match(/^(#{2,3})\s+(.*)$/);

    if (heading) {
      out.push({ heading: current.heading, text: current.lines.join("\n") });
      current = { heading: heading[2]!.trim(), lines: [] };
      continue;
    }

    current.lines.push(line);
  }

  out.push({ heading: current.heading, text: current.lines.join("\n") });

  return out;
}

/**
 * Every page in `docs/`, as search entries.
 *
 * Rebuilt per request rather than cached. Twenty markdown files is a few
 * milliseconds, and a stale index while someone is writing is worse than the
 * work of building it — the same reasoning as rendering pages on request.
 */
export async function buildIndex(): Promise<SearchEntry[]> {
  const entries: SearchEntry[] = [];

  // Every page, not every file: the generated tool pages have to be findable
  // too, or search silently knows less than the sidebar shows.
  for (const slug of await allSlugs()) {
    const source = await pageSource(slug);
    if (source === null) continue;

    const { data, body } = parseFrontmatter(source);

    const page = data.title ?? titleOf(slug) ?? slug;
    const group = sectionOf(slug)?.title ?? "Docs";
    const resolved = substitute(body);

    for (const section of sections(resolved)) {
      // Strip the h1, which repeats the page title already carried on the entry.
      const text = plain(section.text.replace(/^#\s+.*$/m, ""));

      // A heading with nothing under it is still worth finding — it is a real
      // place on the page. A page-level entry with no text is not.
      if (!text && !section.heading) continue;

      const title = section.heading ?? page;
      const url = section.heading
        ? `/docs/${slug}#${slugify(section.heading)}`
        : `/docs/${slug}`;

      // The page title and summary join the haystack of every section, so
      // "approval mode picker" finds the section on the approval page even
      // though only one of those words is in the section itself.
      const haystack = `${title} ${page} ${data.summary ?? ""} ${text}`
        .toLowerCase();

      entries.push({
        url,
        page,
        group,
        title,
        // A normalised copy is appended so that a query typed as words finds a
        // term written with punctuation: someone searching "no auto approve"
        // is looking for `--no-auto-approve`, and "read file" for `read_file`.
        text: `${haystack} ${haystack.replace(/[-_/.]+/g, " ")}`.replace(
          /\s+/g,
          " ",
        ),
        snippet: snippetOf(text || (data.summary ?? "")),
      });
    }
  }

  // Nav order, so equal scores read in reading order rather than in whatever
  // order the filesystem returned. Children are included — a tool page left out
  // of this list scores -1 and sorts to the very front.
  const order = NAV.flatMap((section) =>
    section.entries.flatMap((entry) => [entry, ...(entry.children ?? [])]),
  ).map((entry) => entry.title);

  const rank = (title: string) => {
    const at = order.indexOf(title);
    return at === -1 ? order.length : at;
  };

  return entries.sort((a, b) => rank(a.page) - rank(b.page));
}
