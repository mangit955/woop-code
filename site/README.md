# Woopcode landing page

One static screen, split down the middle: the pitch and install command on the
left, the recorded demo on an ambient backdrop on the right. No nav, no
sections, no scrolling. Built with Bun's HTML bundler and React — no framework,
no external fonts or CDNs.

```bash
bun run site
```

Then open http://localhost:3000. `--hot` is on, but **CSS edits need a server
restart** — Bun's dev server caches the bundled stylesheet.

```bash
bun run site:build   # static output in site/dist
```

## Layout

| Path                             | What it is                                                       |
| -------------------------------- | ---------------------------------------------------------------- |
| `index.html`                     | Entry document and metadata.                                     |
| `server.ts`                      | `Bun.serve` — the page plus the static assets in `public/`.      |
| `src/App.tsx`                    | The whole page: left pane and the scene.                         |
| `src/styles.css`                 | The design system; tokens live in `:root`.                       |
| `src/components/Scene.tsx`       | Right pane — drawn backdrop plus the demo card.                  |
| `src/components/CopyCommand.tsx` | The install field and its copy button.                           |
| `src/components/Logo.tsx`        | The ▛▜ mark and the wordmark. See below.                         |
| `public/fonts/`                  | Inter, latin subset. See Typography.                             |
| `public/terminal1.mp4`           | What the demo card plays — `../public/terminal1.gif` re-encoded. |
| `public/main.png`                | Source screenshot, 3200x1672. Not served.                        |
| `public/hero.jpg`                | Still frame from `main.png`, unused. Route kept in `server.ts`.  |

The page holds itself to one screen with `overflow: hidden` on `body` and a
full-height grid. **Below 900px it stacks and scrolls** — a 50/50 split cannot
fit both halves on a phone.

## The logo

The mark is the block-drawing pair **▛▜** drawn as real pixels. `▛` fills its
upper-left, upper-right and lower-left quadrants and `▜` fills its upper-left,
upper-right and lower-right, so together they are a 4x2 grid with six cells
filled — a bar with a leg at each end:

```
████
█  █
```

Each cell carries its own step along a blue ramp around `#6EA8FE` instead of a
smooth gradient fill, so the gradient reads as pixels. `public/favicon.svg` is
the same six cells on a dark tile — keep the two in sync.

(The previous logo was the TUI's FIGlet ANSI Shadow wordmark, converted from
`tui/src/components/AsciiLogo.tsx`. It is gone from the site, but that art is
still what the TUI prints on launch.)

## Typography

Inter, self-hosted — latin subset, variable weight 100–900, one 48KB `.woff2`
in `public/fonts/`, copied from the `@fontsource-variable/inter` dev dependency.
No third-party requests at runtime.

Refresh it after bumping that dependency:

```bash
cp node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2 \
   site/public/fonts/inter-latin.woff2
```

`styles.css` references the file with a **relative** path. Bun's CSS bundler
resolves `url()` at build time, so an absolute `/fonts/...` fails to build — and
because the file is under the inline threshold the bundler embeds it in the
stylesheet as a data URI rather than emitting a separate asset. That costs about
64KB of render-blocking CSS and buys no font-swap flash.

## The backdrop

Drawn in SVG inside `Scene.tsx`, not an image: a sky gradient, a low sun, and
four ridge layers that darken as they come forward. Nothing to download, and it
scales to any viewport. `preserveAspectRatio="xMidYMax slice"` keeps the horizon
pinned to the bottom and crops the sides.

## Regenerating the media

```bash
ffmpeg -y -i ../public/terminal1.gif -movflags faststart -pix_fmt yuv420p -crf 26 public/terminal1.mp4
ffmpeg -y -i ../public/terminal1.gif -vframes 1 public/demo-poster.jpg
```

The still, from `public/main.png`. The crop also removes the Xnapper watermark
in the bottom-right corner, so keep the bottom edge above y=1500 of the source:

```bash
ffmpeg -y -i public/main.png -vf "crop=2171:1431:513:76,scale=2064:-2" -q:v 3 public/hero.jpg
```

To show the still instead of the clip, swap the `<video>` in `Scene.tsx` for
`<img src="/hero.jpg">`; both assets and routes are there.

## Notes

- `site/` is excluded from the published npm package (`.npmignore`) and from the
  root `tsconfig.json`; it typechecks against `site/tsconfig.json`, which is the
  only place DOM types are enabled.
- The copy button uses the async Clipboard API with an `execCommand` fallback
  for browsers that block it.
