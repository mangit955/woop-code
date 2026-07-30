import { describe, expect, test } from "bun:test";
import { formatDuration } from "./TurnFooter";

describe("turn duration formatting", () => {
  test("keeps tenths under a minute so the clock reads as running", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(3_540)).toBe("3.5s");
    expect(formatDuration(7_000)).toBe("7.0s");
    expect(formatDuration(59_940)).toBe("59.9s");
  });

  test("switches to minutes once tenths stop being useful", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(65_400)).toBe("1m 5s");
    expect(formatDuration(3_723_000)).toBe("62m 3s");
  });

  test("never renders a negative clock if the timestamps disagree", () => {
    expect(formatDuration(-250)).toBe("0.0s");
  });
});
