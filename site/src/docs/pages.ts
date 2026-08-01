/**
 * Where a page's markdown comes from.
 *
 * Most pages are files in `docs/`. Tool reference pages are not: there is one
 * per entry in the tool registry, and writing thirteen near-identical files by
 * hand would be transcribing what the code already knows — the thing
 * system.md §8 rule 3 exists to prevent. So a tool page is generated markdown,
 * fed through the same renderer as every other page.
 *
 * A hand-written file always wins. `docs/reference/tools/read-file.md` exists
 * because `read_file` has behaviour worth explaining — truncation, the
 * workspace boundary, its error strings — and the generated version is the
 * floor rather than the ceiling.
 */

import surface from "./surface.json";

const DOCS_ROOT = new URL("../../../docs/", import.meta.url);

/** `read_file` → `read-file`. Underscores are not URLs. */
export function toolSlug(name: string): string {
  return name.replace(/_/g, "-");
}

export interface ToolPage {
  name: string;
  slug: string;
}

/** Every tool, as a docs path. Registry order — it groups related tools. */
export const TOOL_PAGES: ToolPage[] = surface.tools.map((tool) => ({
  name: tool.name,
  slug: `reference/tools/${toolSlug(tool.name)}`,
}));

/** One sentence about what running this tool costs you, by effect class. */
const EFFECT_NOTE: Record<string, string> = {
  read: "Read-only: it never changes the workspace and never asks for approval.",
  write:
    "Changes the workspace, so it pauses on a unified diff and waits for you.",
  shell: "Runs a shell command, so it is gated by your approval mode.",
  ask: "Stops the turn and waits for your answer.",
};

/** Extra warnings that apply to a whole effect class rather than one tool. */
const EFFECT_WARNING: Record<string, string> = {
  shell: `:::warning
Intended for short, non-interactive commands. It does not start servers or
watch processes, and a command that waits for input will sit there until you
cancel the turn.
:::`,
  write: `:::note
Nothing is written until you approve the diff. Rejecting is not an error — the
agent is told the edit was declined and carries on from there.
:::`,
};

/**
 * The generated page for one tool.
 *
 * Deliberately thin. It answers what a reference page is for — what does this
 * take, what does it do, what does it cost — and links to the guide for
 * anything that needs a paragraph.
 */
function toolPage(name: string): string | null {
  const tool = surface.tools.find((entry) => entry.name === name);
  if (!tool) return null;

  const note = EFFECT_NOTE[tool.effect] ?? "";
  const warning = EFFECT_WARNING[tool.effect] ?? "";

  const example = tool.parameters.length
    ? `\`\`\`ts\n${name}({ ${tool.parameters
        .filter((parameter) => parameter.required)
        .map((parameter) => `${parameter.name}: "…"`)
        .join(", ")} })\n\`\`\``
    : `\`\`\`ts\n${name}()\n\`\`\``;

  return `---
title: ${name}
type: reference
summary: ${tool.description}
related:
  - /docs/reference/tools
  - /docs/guides/approval-modes
since: 0.6.0
---

# \`${name}\`

{{tool:${name}:description}} ${note}

## Parameters

{{tool:${name}:params}}

## Example

${example}

## Approval

{{tool:${name}:gate}}

${warning}

## See also

- [Tools](/docs/reference/tools) — every tool, and which of them can change
  your files
- [Approval modes](/docs/guides/approval-modes) — what gates the tools that
  change things
`;
}

/**
 * The markdown for a docs path, or null when there is no such page.
 *
 * A file on disk is preferred; a tool without one falls back to the generated
 * page. Path traversal is refused rather than normalised — the same posture as
 * resolveWorkspacePath in the product.
 */
export async function pageSource(slug: string): Promise<string | null> {
  if (slug.includes("..") || slug.startsWith("/")) return null;

  const file = Bun.file(new URL(`${slug}.md`, DOCS_ROOT));
  if (await file.exists()) return file.text();

  const tool = TOOL_PAGES.find((page) => page.slug === slug);
  return tool ? toolPage(tool.name) : null;
}

/** Whether a docs path resolves to anything — a file or a generated page. */
export async function pageExists(slug: string): Promise<boolean> {
  return (await pageSource(slug)) !== null;
}

/** Every page on the site, files first, in no particular order. */
export async function allSlugs(): Promise<string[]> {
  const glob = new Bun.Glob("**/*.md");
  const slugs: string[] = [];

  for await (const entry of glob.scan(DOCS_ROOT.pathname)) {
    slugs.push(entry.replace(/\.md$/, ""));
  }

  for (const page of TOOL_PAGES) {
    if (!slugs.includes(page.slug)) slugs.push(page.slug);
  }

  return slugs;
}
