# Woopcode docs — design system

The landing page (`site/src/styles.css`) is the parent system. This document
covers only what docs add: reading typography, density rules, the depth-decay
rule, the light/dark mapping, and the three page contracts.

Nothing here forks the landing page. `site/src/docs/tokens.css` layers on top of
the existing `:root`, so a change to `--violet`, `--rule`, `--frame`, or the
font stack propagates into the docs automatically.

---

## 1. The governing rule

**Every reader arrived mid-task and is going back to their terminal.**

Optimise for time-to-answer, not completeness. A page is good when it can be
*left* quickly. Every decision below follows from that sentence, and when two
rules conflict, this one wins.

A corollary that matters for a coding agent specifically: the reader is deciding
whether to trust a program with write access to their repository. Ambiguity
about what Woopcode will do without asking is not a documentation gap, it is a
safety problem. Precision beats polish on every page that touches approval,
diffs, or the shell.

---

## 2. Inherited tokens

Consumed from `site/src/styles.css`, never redefined:

| Token | Value | Use in docs |
| --- | --- | --- |
| `--page-bg` | `#e0dcf9` | The ground the content surface floats on |
| `--rule` | `rgba(38,32,74,0.12)` | Every hairline, including table and code borders |
| `--frame` | `min(1320px, 94vw)` | Outer measure; the three-pane grid divides this |
| `--violet` | `#8b7bff` | Links, active nav rail, focus rings. Nothing else |
| `--ease` | `cubic-bezier(0.22,1,0.36,1)` | All transitions |
| `--sans` | Inter Variable, self-hosted | Body and headings |
| `--mono` | SF Mono / JetBrains Mono stack | Code, keys, tool names, paths |

**No third-party requests.** The landing page self-hosts its font subset and
makes no external calls. Docs keep that: no CDN, no Google Fonts, no hosted
search, no analytics beacon.

---

## 3. Typography

Docs read longer than a landing page, so the body is larger and looser than
`styles.css` uses, and the measure is wider than the landing's copy column.

| Role | Size / line-height | Weight | Tracking |
| --- | --- | --- | --- |
| Page title (h1) | 32px / 1.25 | 560 | `-0.02em` |
| Section (h2) | 22px / 1.35 | 540 | `-0.017em` |
| Subsection (h3) | 17px / 1.4 | 560 | `-0.012em` |
| Body | 17px / 1.7 | 400 | `-0.011em` |
| Small / captions | 14px / 1.6 | 400 | `-0.008em` |
| Code (block) | 14px / 1.6 | 400 | `0` |
| Code (inline) | 0.9em / inherit | 450 | `0` |
| Nav item | 14px / 1.4 | 420 | `-0.012em` |
| Nav group label | 11px / 1.2 | 560 | `0.06em`, uppercase |

**Measure: 68–74 characters** (`--doc-measure: 70ch`). Wider than the landing
page's copy because docs are scanned in vertical sweeps, not read in a single
sitting.

**h3 is the deepest heading.** Rejected from the Claude Code hooks page: five
levels of nesting means no one can hold the structure. Anything that wants an
h4 is a table, a definition list, or its own page.

Inline code is `450` weight rather than `400` because Inter's mono fallback at
0.9em otherwise reads lighter than the surrounding text and disappears mid-
sentence.

---

## 4. Spacing

One rhythm unit: **4px**. Everything is a multiple.

| Gap | Value |
| --- | --- |
| Paragraph → paragraph | 16px |
| Paragraph → h2 | 44px |
| Paragraph → h3 | 28px |
| Heading → its first paragraph | 12px |
| Around a code block | 20px |
| Around a table | 24px |
| Page top padding | 56px |
| Between nav items | 4px (with 6px vertical padding inside each) |

The asymmetry matters: the gap *above* a heading is roughly three times the gap
*below* it, so a heading binds to the text it introduces rather than floating
between two blocks. This is the single highest-leverage spacing decision on the
page and it is the thing most docs sites get wrong.

---

## 5. The depth-decay rule

**Visual energy decreases monotonically with depth.** This is the rule that
keeps the docs from becoming exhausting at minute twenty, and it is the direct
consequence of the Linear finding in `references.md`.

| Level | Allowed | Forbidden |
| --- | --- | --- |
| **Docs home** | `Backdrop` / `AsciiCanvas`, `ScrambleText`, card grid, crosshairs, reveal on first block | — |
| **Section overview** | Card grid, one accent rule, static | Backdrop, scramble, crosshairs, reveal |
| **Guide** | Callouts, terminal frames, diff blocks | All decoration; color beyond links and callout rules |
| **Reference** | Tables, code, hairlines | Everything else, including callouts unless the note is a safety warning |

Concretely: `Backdrop`, `AsciiCanvas`, `ScrambleText`, and the `.cross`
crosshairs appear on exactly one docs page — the home. They are the landing
page's signature and reusing them on body pages converts a signature into noise.

Reveal-on-scroll (`data-reveal`, `--reveal-delay`) is limited to the page title
and the first content block, and only on home and section overviews. Docs are
revisited; anything that animates on the second visit reads as slow.

`prefers-reduced-motion: reduce` disables reveals, the sliding nav rail, and
page transitions entirely. Not a nicety — an agent's docs are read by people
under time pressure.

---

## 6. Color

Color carries meaning, never decoration.

- **Violet (`--violet`)** — links, the active nav rail, focus rings. Nothing else.
- **Callout rules** — a 2px left rule in the state color, no filled background,
  no emoji, no icon. Four states only, mapped to the TUI so the docs and the
  product agree: Note (`--rule`), Tip (`--violet`), Warning (`warningBase`
  `#fbbf24`), Danger (`dangerBase` `#f87171`).
- **Diff bands** — `diffAddBg #16293d` / `diffRemoveBg #3a1e2b` with markers
  `diffAdd #7dd3fc` / `diffRemove #f0a6bb`, taken verbatim from `theme.ts`.
- **Everything else** — text, hairlines, surfaces.

No colored badges on nav items, no icon set in the sidebar, no section colors.

### Light and dark

Light is the default; it is what the landing page hands off to. Dark adopts the
TUI palette **exactly**, so a code block in the docs and the same output in the
user's terminal are the same colors:

| Docs token | Light | Dark | Dark source |
| --- | --- | --- | --- |
| Page ground | `#e0dcf9` | `#0a0a0a` | `colors.bgBase` |
| Content surface | `#ffffff` | `#0d0d0d` | landing `--bg` |
| Raised surface (code, cards) | `#fbfaff` | `#171717` | `colors.bgLayer01` |
| Body text | `#111111` | `#e5e5e5` | `colors.textBase` |
| Secondary text | `#4a4a4a` | `#a3a3a3` | `colors.textMuted` |
| Faint text | `#6b6b6b` | `#737373` | `colors.textFaint` |
| Hairline | `rgba(38,32,74,0.12)` | `#262626` | `colors.borderMuted` |
| Accent | `#8b7bff` | `#ACA3EC` | `colors.primary` |

The dark half is **generated** by `site/scripts/generate-tokens.ts` from
`tui/src/styles/theme.ts`, not transcribed, so the palettes cannot drift.

Resolution order: `prefers-color-scheme` sets the default;
`:root[data-theme="dark"]` and `:root[data-theme="light"]` override it, and both
directions must win — a reader who forces light inside a dark OS must get light.

---

## 7. Page contracts

Every page declares its type in frontmatter (adopted from Vercel). The type is
a contract, not a label.

```yaml
---
title: Approval modes
type: guide          # concept | guide | reference
summary: One sentence, shown in search results and card grids.
prerequisites: [/docs/getting-started/install]
related: [/docs/reference/slash-commands]
since: 0.6.0         # optional; renders as "Added in woopcode@0.6.0"
---
```

### Concept

Answers: What is it? Why does it exist? What does it prevent? Where does it sit
relative to everything else?

One diagram maximum. No API surface — a concept page that lists parameters has
become a reference page and should be split.

### Guide

A task with a beginning and an end:

1. What you are trying to do (one sentence)
2. The shortest thing that works — a runnable command, above the fold
3. What it looks like when it works — real terminal output, not a description
4. The realistic version — the case with the complications
5. **What goes wrong** — with the literal error text
6. Where to go next

Guides are the only pages allowed to be long; a reader who opened one has
already committed. Step 5 is not a courtesy section — error strings are the
highest-traffic content on any docs site, because people paste them into search.

### Reference

Signature above the fold, no preamble. Every parameter with type, default, and
whether it is required. One minimal example. A link to the guide that shows it
in context.

Reference pages should be **scanned in four seconds and abandoned**. If a
reference page needs three paragraphs of explanation, the explanation belongs in
a guide and the reference should link to it.

---

## 8. Four global rules

1. **Show the real output.** Every behavioural claim gets actual terminal output
   beside it, rendered in the `theme.ts` palette. "Shows a diff for approval" is
   strictly worse than showing the diff.
2. **Name failures with their literal text.** The exact string, copyable, so it
   matches what someone pastes into a search box.
3. **Never document what the code can generate.** Tool names, parameters,
   descriptions, slash commands, approval modes, counts, defaults — all from
   `site/scripts/extract.ts`. `README.md` currently hardcodes "13 tools"; that
   is the bug this rule exists to prevent.
4. **State plainly what Woopcode does not do.** `run_terminal` starts no servers
   and no watch processes. Google Gemini is the only implemented provider.
   `full-auto` will not stop a destructive command. Saying this early buys more
   trust than any amount of polish, and it is already the voice of `README.md`.

---

## 9. Voice

Match `README.md`: plain, specific, unhurried, honest about limits. Second
person. Present tense. No exclamation marks, no "simply", no "just", no "easy" —
if it were easy the reader would not be reading. Prefer the concrete noun to the
abstract one ("the diff" over "the change preview").

Sentences that state a limitation get no hedging and no apology. "Google Gemini
is the only implemented provider" is the whole sentence.

---

## 10. Out of scope for this delivery

Layout and the three-pane grid, sidebar, on-page ToC, `⌘K` palette, search
index, Shiki highlighting, prev/next, breadcrumbs, view transitions, the
component kit. Those follow once the three proof pages show the writing works.
