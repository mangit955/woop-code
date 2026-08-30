import { clampToBudget, remainingMs } from "../runtime/deadline";

/**
 * How long a tool may actually run, given what is left of the turn's wall
 * budget, and whether that is less than it asked for.
 *
 * Without this the deadline is advisory. The loop checks the clock between
 * iterations, but a command started just inside the budget runs to its own
 * timeout regardless — `run_terminal` defaults to 300s, which is 40% of
 * `overfull-hbox`'s entire 750s budget, so one straddling call is enough for the
 * harness to hard-kill the process before the wind-down happens.
 *
 * `process_start` deliberately does not use this: a background process does not
 * hold the loop, so it cannot overshoot the deadline.
 */
export type BudgetedTimeout = {
  /** Seconds to hand the executor. */
  seconds: number;
  /** Whether the budget, rather than the caller, decided that number. */
  clamped: boolean;
};

/**
 * Reads the effective timeout for a command about to start.
 *
 * Call it as late as possible — after approval, not before. The clock runs while
 * a human is deciding, and a number taken at the top of `execute` would grant a
 * command time that was spent waiting to be allowed to run at all.
 */
export function budgetedTimeout(requestedSeconds: number): BudgetedTimeout {
  // `clampToBudget` never returns less than one second, because a zero or
  // negative timeout does not shorten a command — it kills it before it starts.
  // That floor must not *raise* a timeout the caller deliberately made shorter,
  // so the request stays the ceiling and `clamped` only ever means "lowered".
  const seconds = Math.min(requestedSeconds, clampToBudget(requestedSeconds));
  return { seconds, clamped: seconds < requestedSeconds };
}

/**
 * What the model is told when the clock, not its own timeout, killed the call.
 *
 * The standing advice for a timeout is to run it again with a larger one, which
 * is exactly wrong here: the number was never the constraint, and a retry spends
 * what remains of the budget reaching the same end. This is interface rather
 * than a log line — it is what the model reads next — so it says which budget
 * ended the call, what the call was actually granted, and how much is left to
 * spend on saying where the work got to.
 */
export function wallBudgetTimeoutNotice(
  requestedSeconds: number,
  grantedSeconds: number,
): string {
  const left = Math.max(0, Math.round((remainingMs() ?? 0) / 1000));

  return (
    `The turn's wall-clock budget ended this, not the ${requestedSeconds}s timeout ` +
    `requested: only ${grantedSeconds}s of budget were left when it started, and about ` +
    `${left}s remain now. Running it again with more time cannot work — the same clock ` +
    `cuts the next call shorter still. Spend what is left reporting where the work got to.`
  );
}
