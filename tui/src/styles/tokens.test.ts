import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The palette has one source, and this is what keeps it that way.
 *
 * It had fractured into five: `styles/theme.ts`, a markdown palette on One Dark
 * hues, `styles/syntax.ts` on a third set, an orange `#fb923c` selection row
 * hardcoded into four separate pickers, and bare `color="green"` ANSI. One
 * screen could show ten hues from four unrelated systems, and nothing failed —
 * every one of them was a valid colour that rendered fine on its own.
 *
 * So the check is structural rather than visual: outside `styles/`, a colour has
 * to arrive as a token. A new hue can still enter the interface, but only by
 * being named in `theme.ts` first, where the next reader will find it.
 */

const STYLES_DIRECTORY = "styles";
const SOURCE = /\.tsx?$/;
const IS_TEST = /\.test\.tsx?$/;

/** `#abc` and `#aabbcc`, but not a `#` heading or an id in prose. */
const HEX_LITERAL = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/;

/**
 * `color="green"`, `backgroundColor="gray"`, `borderColor="yellow"`.
 *
 * The 16-colour ANSI names are the other way the palette leaks: they are not
 * hex, so they read as harmless, and they render as flat primaries that look
 * like nothing else in the interface.
 */
const ANSI_NAMED = /(?:^|[^A-Za-z])[Cc]olor="[a-zA-Z]+"/;

/**
 * A directory walk, not `git ls-files`.
 *
 * The tracked-files sweep in CLAUDE.md silently skips a file that has not been
 * added yet — which is exactly when a new component carrying a new hex literal
 * would be introduced, and exactly when this test needs to see it.
 */
async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === STYLES_DIRECTORY) continue;
      found.push(...(await sourceFiles(path)));
      continue;
    }

    if (SOURCE.test(entry.name) && !IS_TEST.test(entry.name)) found.push(path);
  }

  return found;
}

/** Comments describe history — "it used to draw #000000" — and are not colours. */
function withoutComments(source: string): string[] {
  return source
    .split("\n")
    .map((line) => (/^\s*(?:\/\/|\/\*|\*)/.test(line) ? "" : line));
}

/**
 * `fileURLToPath`, not `.pathname`.
 *
 * A URL's pathname is percent-encoded, so a checkout under a directory with a
 * space in it — `/Users/me/my repo` — yields `/Users/me/my%20repo`, which no
 * `readdir` will find. The test would then fail on a machine where nothing is
 * actually wrong, which is its own kind of broken.
 */
const TUI_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("colour tokens", () => {
  test("finds the components it is meant to be checking", async () => {
    // A walk that returned nothing would pass every assertion below.
    const files = await sourceFiles(TUI_ROOT);
    expect(files.length).toBeGreaterThan(20);
  });

  test("no component carries a raw hex colour", async () => {
    const offenders: string[] = [];

    for (const file of await sourceFiles(TUI_ROOT)) {
      const lines = withoutComments(await Bun.file(file).text());
      lines.forEach((line, index) => {
        if (HEX_LITERAL.test(line)) {
          offenders.push(`${relative(TUI_ROOT, file)}:${index + 1} ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  test("no component uses a named ANSI colour", async () => {
    const offenders: string[] = [];

    for (const file of await sourceFiles(TUI_ROOT)) {
      const lines = withoutComments(await Bun.file(file).text());
      lines.forEach((line, index) => {
        if (ANSI_NAMED.test(line)) {
          offenders.push(`${relative(TUI_ROOT, file)}:${index + 1} ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
