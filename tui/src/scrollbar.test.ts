import { describe, expect, test } from "bun:test";
import { scrollbarThumb } from "./scrollbar";

describe("scrollbar thumb", () => {
  test("says nothing when the content already fits", () => {
    expect(scrollbarThumb(10, 10, 0)).toBeNull();
    expect(scrollbarThumb(4, 10, 0)).toBeNull();
  });

  test("says nothing when there is no viewport to draw in", () => {
    expect(scrollbarThumb(100, 0, 0)).toBeNull();
  });

  test("touches the top when nothing is scrolled and the bottom when all of it is", () => {
    const top = scrollbarThumb(100, 10, 0);
    expect(top?.start).toBe(0);

    const bottom = scrollbarThumb(100, 10, 90);
    expect(bottom).not.toBeNull();
    expect(bottom!.start + bottom!.size).toBe(10);
  });

  test("sits proportionally between the two", () => {
    const half = scrollbarThumb(100, 10, 45);
    expect(half).not.toBeNull();
    expect(half!.start).toBeGreaterThan(0);
    expect(half!.start + half!.size).toBeLessThan(10);
  });

  test("keeps a thumb visible when the proportion rounds to nothing", () => {
    // 4000 rows of diff in a 12-row window: the exact proportion is 0.036 of a
    // row. Rounded down that is no thumb at all, which reads as "this fits".
    const thumb = scrollbarThumb(4000, 12, 0);
    expect(thumb?.size).toBe(1);
  });

  test("never runs off the end of the track", () => {
    for (const offset of [-50, 0, 33, 90, 500]) {
      const thumb = scrollbarThumb(100, 10, offset);
      expect(thumb).not.toBeNull();
      expect(thumb!.start).toBeGreaterThanOrEqual(0);
      expect(thumb!.start + thumb!.size).toBeLessThanOrEqual(10);
    }
  });
});
