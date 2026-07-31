# Reference research

Seven documentation sites, read in July 2026. For each: **one mechanism adopted,
one explicitly rejected.**

The rule for this pass was that synthesising seven sites produces their average,
and an average is generic — the opposite of what we want. So this is not a survey
of what makes each site good. It is a list of specific transferable decisions,
each with a reason it applies to a terminal-native coding agent in particular.

---

## Bun — `bun.sh/docs/runtime/shell`

**Adopt: the first code block appears before the first section heading.**

The page opens with a one-sentence description and then, immediately, a runnable
example — no "Overview", no "Introduction", no table of contents. Everything
after that is a variation on the opening example, and each variation is one
sentence of prose followed by one block of code. The prose-to-code ratio is
close to 1:1 by line count.

Why it transfers: a reader arriving at "Your first session" wants to see
Woopcode running, not to be told what an agent is. Our quickstart opens with the
install command and the first prompt, and the explanation of what happened comes
after the reader has already seen it happen.

**Adopt also: the `## Security` section that names what is *unsafe*.**

Bun's shell page ends with explicit UNSAFE examples — `bash -c` with
interpolated input, argument injection through `git --upload-pack`. It marks the
dangerous code with a comment reading `UNSAFE` and explains what the user is
still responsible for. This is unusually honest for a docs page and it builds
more trust than the surrounding feature list does.

Direct model for our approval-modes page: `full-auto` gets shown, labelled
unsafe, with the specific thing it will not stop.

**Reject: the single-giant-page structure.**

Bun's shell page covers quickstart, error handling, redirection, piping,
environment, builtins, utilities, the file loader, implementation notes, and
security in one document. It works for Bun because the API is one object with
chained methods. Woopcode's surface is 13 tools, 11 slash commands, a CLI, and a
config file — four unrelated shapes. One page per shape, not one page.

---

## Tailwind — `tailwindcss.com/docs/flex-direction`

**Adopt: the quick-reference table above the fold, before any prose.**

Every utility page opens with a bare two-column table (class → CSS) that answers
the most common question without scrolling and without reading. Examples come
after. The page is built so that the 90% case is a four-second visit.

This becomes our reference-page contract: signature and parameter table first,
prose second. A reader who lands on the `read_file` page usually wants one thing
— what arguments does it take — and should not have to read a paragraph to get
it.

**Reject: one page per unit.**

Tailwind gives every utility its own page, which is right for them because
search is the primary entry point and there are hundreds of utilities with
nothing to say about each. Our 13 tools have a *shared story* — which of them
write, which ask first, which are gated by approval mode. Splitting them into 13
sidebar entries hides the relationships and is the exact move that makes docs
feel like Docusaurus. Tools get one overview page with a grid, plus grouped
detail.

---

## Astro — `docs.astro.build/en/guides/markdown-content`

**Adopt: inline version markers — `Added in: astro@2.0.0`.**

Astro annotates individual features with the version that introduced them, in
place, rather than maintaining a separate compatibility matrix. It means a
single always-current docs set can serve users on older versions without
versioned snapshots.

This is what lets us skip versioned docs entirely at 0.6.0, which was an open
question in the original proposal. Features get `Added in: woopcode@0.6.0`
inline; there is one docs set and a changelog.

**Reject: the promotional banner above the content, and the 3–4 level sidebar.**

Astro's page begins with a paid-course advertisement before the documentation
starts, and its sidebar nests 200+ pages four levels deep. The banner costs
trust at exactly the moment a reader is deciding whether to trust the tool. The
depth means no one can hold the structure in their head. Our sidebar caps at two
levels; anything wanting a third is a table on a page, not a nav entry.

---

## Biome — `biomejs.dev/linter`

**Adopt: reference generated from the source of truth.**

Biome documents 512 lint rules and states the count in prose. That number is
only maintainable because the rule pages and the count are generated from the
rule definitions. Hand-maintaining it would guarantee it is wrong.

We have the same problem at smaller scale, and our README already has the bug:
it says "13 tools" as hand-written prose. `site/scripts/extract.ts` reads
`toolRegistery`, the slash-command `registry`, and `APPROVAL_MODES`, so counts,
names, descriptions, and parameters cannot drift from the product.

**Reject: five package-manager tabs on every install command.**

Biome tabs npm / pnpm / bun / deno / yarn everywhere. Woopcode requires Bun —
`engines.bun >= 1.0.0` — so offering four alternatives implies a choice that
does not exist and buries the one command that works. `InstallRow` already
offers bun and npm; that stays the maximum.

---

## Claude Code — `code.claude.com/docs/en/hooks`

**Adopt: concepts get narrative and a diagram; reference gets tables. Never the
reverse.**

The hooks page is strictly layered — lifecycle diagram and a walked-through
resolution example first, then configuration schema, then per-event tables. The
teaching arc runs why → where → what → how → when, which is the order in which
someone actually discovers they need the feature.

Two things we take directly: the **worked example placed before the schema**
(our approval-modes page shows one command being handled by each mode before it
tabulates the modes), and **warnings threaded inline** rather than collected in
a "Gotchas" section at the bottom — a warning is only useful where the mistake
is made.

**Reject: h4/h5 nesting and ten-column tables.**

The same page runs headings five levels deep and has an event summary table wide
enough to scroll horizontally. That is the cost of documenting a very large
surface on one page. Our cap: h3 is the deepest heading, and any table wider
than five columns becomes a definition list.

---

## Vercel — `vercel.com/docs/functions/quickstart`

**Adopt: structured page frontmatter as a contract.**

Every Vercel docs page carries machine-readable frontmatter: `type` (tutorial /
reference / conceptual), `last_updated`, `prerequisites`, `related`, `summary`.
The page *type* is declared, not implied — which means the template can enforce
the shape, and "Next steps" links are data rather than prose someone remembered
to write.

This is how our three page contracts get enforced instead of merely described.
Every page in `docs/` declares `type: concept | guide | reference`, and the
renderer can later validate that a reference page has a parameter table and a
guide page has a failure section.

**Reject: product upsell inside code blocks.**

Vercel's code fences carry `v0="build"` attributes that turn examples into entry
points for another product. It makes the example about Vercel rather than about
the reader's problem. Our code blocks do one thing: show what to type and what
comes back.

---

## Linear — `linear.app/docs`

**Adopt: decoration is absent from the body, not merely reduced.**

Linear's docs have no icons on nav items, no colored badges, no hero imagery, no
section illustrations, no animated transitions. Color appears in exactly one
place — links. All of the design effort went into type, spacing, and a card grid
that makes the entry points scannable. It is the least decorated site in this
list and the most premium-feeling one, which is the whole argument.

This is the strongest confirmation of the depth-decay rule: our landing page's
crosshairs, `AsciiCanvas` backdrop, and reveal animations do not travel into the
docs body. Section overviews get the card grid; reference pages get nothing but
type.

**Reject: shipping without search or breadcrumbs.**

Linear's restraint goes one step too far — there is no visible search and no
breadcrumb trail, so arriving from a search engine leaves you without a sense of
place. We keep the restraint and add the two orientation affordances Linear
omits. (Search is step 6; breadcrumbs come with the layout in step 3.)

---

## What this changes in the plan

1. **No versioned docs.** Astro's inline `Added in:` markers plus a changelog
   replace version snapshots. One always-current set.
2. **Page `type` is declared in frontmatter**, from Vercel — it turns the three
   page contracts from prose guidance into something enforceable.
3. **Reference pages open with the table, not the prose**, from Tailwind.
4. **Guides open with the worked example, not the schema**, from Claude Code and
   Bun.
5. **Naming what is unsafe is a feature of the docs**, from Bun's shell page —
   it is the single most transferable idea here for a tool whose pitch is that
   it asks before it writes.
6. **The body has no decoration at all**, from Linear.
