/**
 * Markdown → HTML, and the component vocabulary the pages are written in.
 *
 * Every component here exists because one of the three proof pages needed it,
 * not because a documentation site usually has one. That was the point of
 * writing the pages before building the kit:
 *
 *   terminal   `Your first session` shows product output six times
 *   diff       the diff review is the thing Woopcode is for
 *   tabs       install has two mutually exclusive commands
 *   callout    `full-auto` needs a danger notice at the point of danger
 *   copy       every shell block is something to paste
 *   kbd        Enter and Esc appear in prose
 *
 * Notably absent: admonition variants nobody used, collapsible sections, and
 * anything decorative. See site/design/system.md §5.
 */

import { marked } from "marked";

export interface Heading {
  level: 2 | 3;
  id: string;
  text: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

// ─── Code, terminal output, diffs ────────────────────────────────────────────

/**
 * One source line per block, so a wrapped line continues under itself instead
 * of restarting at column zero — where it reads as the next line of output
 * rather than the rest of this one. CSS cannot do this inside a single `<pre>`:
 * `text-indent` applies once per block, not once per visual row.
 *
 * A diff also colours its lines here, from the marker in column one, because
 * that is the only place the marker is still attached to its line.
 */
function codeLines(text: string, isDiff: boolean): string {
  return text
    .split("\n")
    .map((line) => {
      // An empty line still needs height, and an empty block has none.
      if (line.length === 0) return `<span class="line">&nbsp;</span>`;

      let modifier = "";

      if (isDiff) {
        const marker = line[0];
        // `+++`/`---` are file headers, not added or removed lines.
        const isHeader = line.startsWith("+++") || line.startsWith("---");

        if (!isHeader && marker === "+") modifier = " line--add";
        else if (!isHeader && marker === "-") modifier = " line--remove";
        else if (isHeader || marker === "@") modifier = " line--meta";
      }

      return `<span class="line${modifier}">${escapeHtml(line)}</span>`;
    })
    .join("");
}

/** `title="~/your-project"` on a fence's info string. */
function fenceTitle(meta: string | undefined): string | undefined {
  const match = meta?.match(/title="([^"]*)"/);
  return match?.[1];
}

/**
 * A code block, in one of three dresses.
 *
 *   ```bash                  a command to run — gets a copy button
 *   ```terminal title="…"    product output — gets terminal chrome, no copy
 *   ```diff                  a diff — coloured gutter, no copy
 *
 * Terminal output and diffs deliberately have no copy button: copying what the
 * program printed at you is not a thing anyone wants to do, and a button that
 * is never used is noise on every page.
 */
function renderCode(text: string, info: string | undefined): string {
  const [lang, ...rest] = (info ?? "").split(/\s+/);
  const meta = rest.join(" ");
  const title = fenceTitle(meta);

  const isTerminal = lang === "terminal";
  const isDiff = lang === "diff";
  const copyable = !isTerminal && !isDiff;

  const body = `<pre${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${codeLines(
    text,
    isDiff,
  )}</code></pre>`;

  const copy = copyable
    ? `<button class="code__copy" type="button" data-copy aria-label="Copy to clipboard">Copy</button>`
    : "";

  if (isTerminal) {
    return `<figure class="code code--terminal">
      <figcaption class="code__bar">
        <span class="code__dots" aria-hidden="true"></span>
        <span class="code__title">${escapeHtml(title ?? "woopcode")}</span>
      </figcaption>
      ${body}
    </figure>\n`;
  }

  return `<div class="code${isDiff ? " code--diff" : ""}">
    ${title ? `<p class="code__filename">${escapeHtml(title)}</p>` : ""}
    ${copy}${body}
  </div>\n`;
}

// ─── Directives ──────────────────────────────────────────────────────────────

const CALLOUTS = new Set(["note", "tip", "warning", "danger"]);

/**
 * Block directives, processed before the markdown parser sees them:
 *
 *   :::warning            a callout, with the body rendered as markdown
 *   Body text
 *   :::
 *
 *   :::tabs               mutually exclusive alternatives
 *   @tab bun
 *   ```bash
 *   bunx woopcode
 *   ```
 *   @tab npm
 *   ```bash
 *   npx woopcode
 *   ```
 *   :::
 *
 * Directives do not nest. A page that wants a callout inside a tab is a page
 * that has become too clever, and the failure — the inner `:::` closing the
 * outer block — is visible immediately rather than subtle.
 */
/**
 * Directives are replaced by a placeholder, not by their HTML.
 *
 * The obvious implementation — splice the rendered HTML into the markdown and
 * parse the result — does not work: the parser sees that HTML again, and any
 * line of it indented by four spaces becomes an indented code block. The
 * component's own markup ends up escaped and printed on the page.
 *
 * So the HTML is held aside under a token, the token goes through the parser as
 * an ordinary paragraph, and the paragraph is swapped back out afterwards.
 */
async function expandDirectives(
  source: string,
  render: (markdown: string) => Promise<string>,
): Promise<{ source: string; blocks: Map<string, string> }> {
  const pattern = /^:::(\w+)[^\S\n]*\n([\s\S]*?)\n:::[^\S\n]*$/gm;
  const blocks = new Map<string, string>();

  const matches = [...source.matchAll(pattern)];
  if (matches.length === 0) return { source, blocks };

  let out = "";
  let cursor = 0;

  for (const match of matches) {
    const [whole, kind, body] = match as unknown as [string, string, string];

    out += source.slice(cursor, match.index);
    cursor = match.index! + whole.length;

    let html: string;

    if (CALLOUTS.has(kind)) {
      const label = `${kind[0]!.toUpperCase()}${kind.slice(1)}`;
      html =
        `<aside class="callout callout--${kind}">` +
        `<p class="callout__label">${label}</p>` +
        `${await render(body)}</aside>`;
    } else if (kind === "tabs") {
      html = await renderTabs(body, render);
    } else {
      // Unknown directive: leave it visible rather than swallowing the content.
      html =
        `<aside class="callout callout--danger">` +
        `<p class="callout__label">Unknown directive</p>` +
        `<p><code>:::${escapeHtml(kind)}</code> is not a directive.</p>` +
        `${await render(body)}</aside>`;
    }

    const token = `docsdirective${blocks.size}placeholder`;
    blocks.set(token, html);

    // Blank lines around it so the parser treats the token as its own
    // paragraph rather than joining it to the text above.
    out += `\n\n${token}\n\n`;
  }

  return { source: out + source.slice(cursor), blocks };
}

let tabGroupId = 0;

async function renderTabs(
  body: string,
  render: (markdown: string) => Promise<string>,
): Promise<string> {
  const parts = body.split(/^@tab[^\S\n]+(.*)$/gm).slice(1);
  const group = `tabs-${(tabGroupId += 1)}`;

  const labels: string[] = [];
  const panels: string[] = [];

  for (let i = 0; i < parts.length; i += 2) {
    const label = (parts[i] ?? "").trim();
    labels.push(label);
    panels.push(await render(parts[i + 1] ?? ""));
  }

  if (labels.length === 0) return await render(body);

  const buttons = labels
    .map(
      (label, index) =>
        `<button class="tabs__tab" type="button" role="tab"
          data-tab="${escapeHtml(label)}"
          aria-selected="${index === 0}"
          aria-controls="${group}-${index}">${escapeHtml(label)}</button>`,
    )
    .join("");

  const bodies = panels
    .map(
      (panel, index) =>
        `<div class="tabs__panel" id="${group}-${index}" role="tabpanel"
          data-tab="${escapeHtml(labels[index]!)}"${index === 0 ? "" : " hidden"}>${panel}</div>`,
    )
    .join("");

  return (
    `<div class="tabs" data-tabs>` +
    `<div class="tabs__list" role="tablist">${buttons}</div>` +
    `${bodies}</div>`
  );
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function renderMarkdown(
  source: string,
): Promise<{ html: string; headings: Heading[] }> {
  const headings: Heading[] = [];
  const seen = new Map<string, number>();

  const renderer = new marked.Renderer();

  renderer.code = function ({ text, lang }) {
    return renderCode(text, lang ?? undefined);
  };

  renderer.heading = function ({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    const base = slugify(text) || `section-${headings.length + 1}`;

    // Two headings can share a title across a long page; the id must not.
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;

    if (depth === 2 || depth === 3) {
      headings.push({ level: depth, id, text: text.replace(/<[^>]+>/g, "") });
    }

    const anchor =
      depth === 1
        ? ""
        : `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a>`;

    return `<h${depth} id="${id}">${text}${anchor}</h${depth}>\n`;
  };

  const parse = async (markdown: string) =>
    (await marked.parse(markdown, { renderer })) as string;

  const { source: withTokens, blocks } = await expandDirectives(source, parse);

  let html = await parse(withTokens);

  for (const [token, block] of blocks) {
    html = html.replace(new RegExp(`<p>${token}</p>`, "g"), block);
  }

  // Tables are the one thing allowed to scroll sideways — wrapping one destroys
  // the column alignment that makes it readable. Each gets its own container so
  // the overflow stays inside the table and never reaches the page. Code and
  // terminal output wrap instead; see tokens.css.
  const wrapped = html.replace(
    /<table>[\s\S]*?<\/table>/g,
    (table) => `<div class="table-scroll">${table}</div>`,
  );

  return { html: wrapped, headings };
}
