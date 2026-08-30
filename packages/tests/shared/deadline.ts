import { WALL_RESERVE_SEC, remainingMs, setDeadline } from "../../../runtime/deadline";

/**
 * Arms a wall-clock budget with `seconds` genuinely left to spend on tools.
 *
 * The reserve is added back on, because `setDeadline` subtracts it: a caller
 * asking for 30 usable seconds wants `clampToBudget` to answer 30, not
 * `30 - WALL_RESERVE_SEC`. Writing that sum out at each call site is how a test
 * ends up asserting against a budget it did not mean to set.
 *
 * The clock is frozen at zero rather than left on `Date.now`, so the number a
 * tool is granted is decided by the budget alone and not by how long the test
 * took to reach the assertion. `clearDeadline` in an `afterEach` restores both
 * the deadline and the real clock — module state, so a file that arms one and
 * does not clear it leaves every later test in the run on a clock that never
 * moves.
 */
export function budgetWith(seconds: number): void {
  setDeadline(WALL_RESERVE_SEC + seconds, { now: () => 0, startedAt: 0 });
}

/** A wall budget whose clock the test moves by hand. */
export interface DrivenBudget {
  /** Spends wall time, as a provider request or a tool would. */
  advance(ms: number): void;
  /** What was written to `WOOPCODE_MAX_WALL_SEC`, for a caller that wants to assert on it. */
  wallSeconds: number;
}

/**
 * Arms a wall budget for a turn that will run through `agentLoop`, on a clock
 * the test drives, positioned `msRemaining` short of the deadline.
 *
 * `budgetWith` above cannot serve this: it pins the deadline to `startedAt: 0`,
 * and `agentLoop` re-arms from `WOOPCODE_MAX_WALL_SEC` the moment the turn
 * starts — computing the instant from the *process* start, which no test can
 * read. So the deadline is armed once on the real clock to discover where it
 * lands, and the fake is then positioned relative to that. Both calls name the
 * same budget, so the loop's re-arm lands on the same instant and only the
 * clock reading it changes.
 *
 * The environment variable is set here because the loop reads it rather than
 * taking an argument; restoring it belongs to the caller's `afterEach`, beside
 * the `clearDeadline` that puts the real clock back.
 */
export function budgetDrivenBy(
  usableSeconds: number,
  msRemaining: number,
): DrivenBudget {
  const wallSeconds = WALL_RESERVE_SEC + usableSeconds;

  setDeadline(wallSeconds);
  const deadlineAt = Date.now() + remainingMs()!;

  let now = deadlineAt - msRemaining;
  setDeadline(wallSeconds, { now: () => now });
  process.env.WOOPCODE_MAX_WALL_SEC = String(wallSeconds);

  return {
    advance(ms: number) {
      now += ms;
    },
    wallSeconds,
  };
}
