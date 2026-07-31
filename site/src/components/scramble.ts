/**
 * The frame maths behind <ScrambleText />, kept separate from the component so
 * it can be exercised without a browser — the effect it drives runs on
 * requestAnimationFrame, which a headless or backgrounded page throttles into
 * uselessness.
 */

/**
 * Drawn from the same vocabulary as the glyph field behind the panel, so the
 * command looks like it is being resolved out of that noise rather than
 * cross-faded.
 */
export const GLYPHS = "abcdefghijklmnopqrstuvwxyz0123456789-_/@.$#%*+=";

/** Frames before the next column starts scrambling. */
const STAGGER = 1.1;
/** How long a column stays scrambled before it settles. */
const SETTLE = 12;
/** Spread on both, so columns do not churn in lockstep. */
const START_JITTER = 6;
const SETTLE_JITTER = 6;

export type Column = { start: number; end: number };

export function randomGlyph(random: () => number = Math.random) {
  return GLYPHS[Math.floor(random() * GLYPHS.length)]!;
}

/**
 * One entry per character column, covering whichever of the two strings is
 * longer so columns that are being added or dropped animate too.
 */
export function planColumns(
  from: string,
  to: string,
  random: () => number = Math.random,
): Column[] {
  const length = Math.max(from.length, to.length);

  return Array.from({ length }, (_, index) => {
    const start = index * STAGGER + random() * START_JITTER;
    return { start, end: start + SETTLE + random() * SETTLE_JITTER };
  });
}

/**
 * The text at `frame`, and whether every column has landed. A column shows the
 * old character before its start, noise until its end, then the new one.
 */
export function morphFrame(
  from: string,
  to: string,
  plan: Column[],
  frame: number,
  glyph: () => string = randomGlyph,
): { text: string; settled: boolean } {
  let settled = true;
  let text = "";

  for (let index = 0; index < plan.length; index++) {
    const target = to[index] ?? "";
    const { start, end } = plan[index]!;

    if (frame >= end) {
      text += target;
    } else if (frame >= start) {
      // Spaces hold, so the command keeps its word shape while it churns.
      text += target === " " ? " " : glyph();
      settled = false;
    } else {
      text += from[index] ?? "";
      settled = false;
    }
  }

  return { text, settled };
}
