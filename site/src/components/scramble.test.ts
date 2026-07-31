import { expect, test } from "bun:test";
import { GLYPHS, morphFrame, planColumns } from "./scramble";

const BUN = "bun add -g woopcode";
const NPM = "npm install -g woopcode";

/** Runs a morph to completion, returning every frame it drew. */
function run(from: string, to: string, glyph?: () => string, limit = 400) {
  const plan = planColumns(from, to);
  const frames: string[] = [];

  for (let frame = 0; frame < limit; frame++) {
    const { text, settled } = morphFrame(from, to, plan, frame, glyph);
    frames.push(text);
    if (settled) return frames;
  }

  throw new Error(`morph did not settle within ${limit} frames`);
}

test("settles on the target, growing and shrinking", () => {
  expect(run(BUN, NPM).at(-1)).toBe(NPM);
  expect(run(NPM, BUN).at(-1)).toBe(BUN);
});

test("settles in a plausible number of frames", () => {
  const frames = run(BUN, NPM).length;
  // ~0.5-1.5s at 60fps. A regression in the stagger shows up here.
  expect(frames).toBeGreaterThan(20);
  expect(frames).toBeLessThan(90);
});

test("never churns a column whose target is a space", () => {
  // A column shows the old character, then noise, then the new one. Where the
  // new one is a space the noise step is skipped, so the word gaps do not fill
  // in mid-morph. Before that column starts it is still showing the old text,
  // which may well be a letter — that is the point of the sentinel.
  const NOISE = "";
  const spaces = [...NPM].flatMap((char, i) => (char === " " ? [i] : []));

  for (const frame of run(BUN, NPM, () => NOISE)) {
    for (const index of spaces) {
      expect(frame[index]).not.toBe(NOISE);
    }
  }
});

test("only ever draws the old text, the new text, or known glyphs", () => {
  const allowed = new Set([...GLYPHS, ...BUN, ...NPM]);

  for (const frame of run(BUN, NPM)) {
    for (const char of frame) expect(allowed.has(char)).toBe(true);
  }
});

test("starts from the old text and does not jump straight to the new one", () => {
  const frames = run(BUN, NPM);

  expect(frames[0]).not.toBe(NPM);
  expect(frames.length).toBeGreaterThan(1);
});
