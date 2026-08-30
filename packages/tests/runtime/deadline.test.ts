import { describe, test, expect, afterEach } from "bun:test";
import {
  WALL_RESERVE_SEC,
  clampToBudget,
  clearDeadline,
  deadlineReached,
  now,
  remainingMs,
  setDeadline,
} from "../../../runtime/deadline";

/**
 * The deadline is module state, and module state outlives a file.
 *
 * A test that installed a fake clock and did not clear it would leave every
 * later test in the run measuring elapsed time against a number that never
 * moves — which is exactly the class of failure the injected clock exists to
 * avoid in the first place.
 */
afterEach(() => {
  clearDeadline();
});

/** A clock the test moves by hand. */
function fakeClock(start = 0) {
  let at = start;
  return {
    now: () => at,
    advance(ms: number) {
      at += ms;
    },
  };
}

describe("the wall-clock deadline", () => {
  test("the reserve is subtracted from the budget the operator gave", () => {
    const clock = fakeClock();
    setDeadline(600, { now: clock.now, startedAt: 0 });

    expect(remainingMs()).toBe((600 - WALL_RESERVE_SEC) * 1000);
  });

  test("it is counted from process start, so a second turn cannot restart it", () => {
    const clock = fakeClock();
    setDeadline(600, { now: clock.now, startedAt: 0 });

    // A turn's worth of time passes, then the next turn sets the same budget
    // again. The harness has been counting throughout, so the deadline must not
    // move — a turn granted the whole budget afresh would overrun it.
    clock.advance(100_000);
    setDeadline(600, { now: clock.now, startedAt: 0 });

    expect(remainingMs()).toBe((600 - WALL_RESERVE_SEC) * 1000 - 100_000);
  });

  test("the deadline is reached once the budget less the reserve is spent", () => {
    const clock = fakeClock();
    setDeadline(600, { now: clock.now, startedAt: 0 });

    clock.advance((600 - WALL_RESERVE_SEC) * 1000 - 1);
    expect(deadlineReached()).toBe(false);

    clock.advance(1);
    expect(deadlineReached()).toBe(true);
  });

  test("a budget no larger than the reserve is spent before it starts", () => {
    const clock = fakeClock();
    setDeadline(WALL_RESERVE_SEC, { now: clock.now, startedAt: 0 });

    expect(remainingMs()).toBe(0);
    expect(deadlineReached()).toBe(true);
  });

  // Every reader has to answer "keep going" for a session that never opted in,
  // or turning the feature off would end turns rather than leave them alone.
  test("an unbudgeted session is never out of time", () => {
    expect(deadlineReached()).toBe(false);
    expect(remainingMs()).toBeUndefined();
  });

  test("now() reads the injected clock, and clearDeadline puts the real one back", () => {
    const clock = fakeClock(1_000);
    setDeadline(600, { now: clock.now, startedAt: 0 });
    expect(now()).toBe(1_000);

    clearDeadline();
    // The real clock, not the fake one frozen at 1,000.
    expect(now()).toBeGreaterThan(1_600_000_000_000);
  });
});

describe("clamping a tool timeout to the budget", () => {
  test("an unbudgeted session gets the timeout it asked for", () => {
    expect(clampToBudget(300)).toBe(300);
  });

  test("a timeout that fits is passed through", () => {
    const clock = fakeClock();
    setDeadline(600, { now: clock.now, startedAt: 0 });

    expect(clampToBudget(30)).toBe(30);
  });

  test("a timeout that outlives the budget is cut to what is left", () => {
    const clock = fakeClock();
    setDeadline(160, { now: clock.now, startedAt: 0 });

    // 160s less the reserve leaves 100s, so a default 300s command gets 100.
    expect(clampToBudget(300)).toBe(100);
  });

  // Zero or a negative number is not a shorter timeout, it is a command killed
  // before it starts — reported as a failure that says nothing about the clock.
  test("the clamp never returns less than a second", () => {
    const clock = fakeClock();
    setDeadline(600, { now: clock.now, startedAt: 0 });
    clock.advance((600 - WALL_RESERVE_SEC) * 1000);

    expect(clampToBudget(300)).toBe(1);
  });
});
