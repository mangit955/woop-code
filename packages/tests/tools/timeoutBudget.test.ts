import { afterEach, describe, expect, test } from "bun:test";
import {
  budgetedTimeout,
  formatTimeoutError,
  wallBudgetTimeoutNotice,
} from "../../../tools/timeoutBudget";
import {
  WALL_RESERVE_SEC,
  clearDeadline,
  setDeadline,
} from "../../../runtime/deadline";

/**
 * The pure half of the timeout budget: the number a tool is given, and the
 * sentence the model reads when that number is what ended its command.
 *
 * `timeoutBudget.integration.test.ts` is the other half, and kills real
 * processes to prove the number is honoured. Nothing here spawns anything.
 */

afterEach(clearDeadline);

/** A budget with `seconds` left on it, on a clock that does not move. */
function budgetWith(seconds: number) {
  setDeadline(WALL_RESERVE_SEC + seconds, { now: () => 0, startedAt: 0 });
}

const STANDING = "Run it again with a larger timeout.";

describe("the timeout a tool is given", () => {
  test("an unbudgeted turn is handed exactly what it asked for", () => {
    expect(budgetedTimeout(300)).toEqual({
      seconds: 300,
      requested: 300,
      clamped: false,
    });
  });

  test("a budget shorter than the request lowers it", () => {
    budgetWith(10);

    expect(budgetedTimeout(300)).toEqual({
      seconds: 10,
      requested: 300,
      clamped: true,
    });
  });

  test("the one-second floor never raises a deliberately short timeout", () => {
    // The floor exists so a spent budget cannot hand a command zero seconds and
    // kill it before it starts. It must not turn a caller's 0.05s into 1s.
    budgetWith(0);

    expect(budgetedTimeout(0.05)).toEqual({
      seconds: 0.05,
      requested: 0.05,
      clamped: false,
    });
  });
});

describe("what the model is told", () => {
  test("a clamped kill gets the clock, not the standing advice", () => {
    budgetWith(10);
    const budgeted = budgetedTimeout(300);

    const result = formatTimeoutError("Command timed out", budgeted, STANDING);

    expect(result).toContain("wall-clock budget");
    expect(result).not.toContain(STANDING);
  });

  test("an ordinary timeout keeps the standing advice", () => {
    const budgeted = budgetedTimeout(300);

    const result = formatTimeoutError("Command timed out", budgeted, STANDING);

    expect(result).toContain(STANDING);
    expect(result).not.toContain("wall-clock budget");
  });

  test("a tool with no standing advice returns the bare error", () => {
    const budgeted = budgetedTimeout(300);

    // `repl` explains a lost session in the message itself. An empty string
    // must not leave two blank lines hanging off the end of it.
    expect(formatTimeoutError("timed out after 1 seconds", budgeted, "")).toBe(
      "Error: timed out after 1 seconds",
    );
  });

  test("it reports what was granted, never time that was not there", () => {
    // `clampToBudget` floors at one second, so a command starting on a spent
    // clock is granted 1s when nothing was left. Saying "1s was left when it
    // started" would be a number the model could act on and that never existed.
    budgetWith(0);

    const notice = wallBudgetTimeoutNotice(300, 1);

    expect(notice).toContain("the budget allowed it only 1s");
    expect(notice).not.toContain("left when it started");
  });

  test("a cleared deadline says nothing rather than saying zero", () => {
    // No budget armed at all: `remainingMs()` is undefined, and `?? 0` would
    // state "about 0s remain" — a confident wrong number about a turn that has
    // no deadline on it.
    const notice = wallBudgetTimeoutNotice(300, 5);

    expect(notice).not.toContain("remain");
    expect(notice).toContain("the budget allowed it only 5s");
  });

  test("an armed deadline does report what is left", () => {
    budgetWith(42);

    expect(wallBudgetTimeoutNotice(300, 42)).toContain("About 42s of the turn remain");
  });
});
