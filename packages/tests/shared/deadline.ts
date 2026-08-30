import { WALL_RESERVE_SEC, setDeadline } from "../../../runtime/deadline";

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
