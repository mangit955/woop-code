import { clampToBudget, remainingMs } from "../runtime/deadline";

/**
 * How long a tool may actually run, given what is left of the turn's wall
 * budget, and whether that is less than it asked for.
 *
 * Without this the deadline is advisory — `runtime/deadline.ts` documents why,
 * and this module is the half of it the tools see: the number to hand the
 * executor, and the sentence to give the model when that number is what ended
 * the call.
 *
 * `process_start` deliberately does not use this: a background process does not
 * hold the loop, so it cannot overshoot the deadline.
 */
export type BudgetedTimeout = {
  /** Seconds to hand the executor. */
  seconds: number;
  /**
   * Seconds the caller asked for.
   *
   * Carried rather than left to each caller to hold separately: every call site
   * needs both numbers to explain a clamped kill, and the two travelling apart
   * is how one of them gets passed in the wrong order.
   */
  requested: number;
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
  return { seconds, requested: requestedSeconds, clamped: seconds < requestedSeconds };
}

/**
 * Did this error come from a timeout rather than from the command itself?
 *
 * Kept here beside the message it selects, because the test is stringly typed
 * and was being written out per tool — three copies of
 * `message.includes("timed out")`, one added by each caller that grew a budget.
 * A fourth tool spelling it differently would silently get the standing advice
 * on a clamped kill, which is the one thing this module exists to prevent.
 *
 * Substring rather than an error type because the string is all there is: the
 * executor and `replSession` both raise a plain `Error`, and typing them is a
 * change to code these budgets do not otherwise touch.
 */
export function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("timed out");
}

/**
 * The message a timed-out tool returns, from whichever clock ended it.
 *
 * One function rather than the same four lines in each tool. The three that take
 * a timeout had identical copies, and nothing would have stopped a fourth from
 * being written without the budget branch at all — the failure mode `TOOL_EFFECTS`
 * avoids by making a missing entry mean `unclassified` rather than nothing.
 *
 * `standingAdvice` is what the tool says when the clock was not involved, which
 * differs per tool: run_tests talks about servers, run_terminal about
 * process_start. `repl` has none, and omitting it leaves the bare error rather
 * than a message with two blank lines hanging off it.
 */
export function formatTimeoutError(
  message: string,
  budgeted: BudgetedTimeout,
  standingAdvice = "",
): string {
  const advice = budgeted.clamped
    ? wallBudgetTimeoutNotice(budgeted.requested, budgeted.seconds)
    : standingAdvice;

  return advice ? `Error: ${message}\n\n${advice}` : `Error: ${message}`;
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
 *
 * It reports what the command was *granted* rather than what was "left when it
 * started", because those come apart: `clampToBudget` floors at one second, so
 * a command starting on an already-overspent clock is granted 1s when nothing
 * was left. Granted is true by construction; left was not.
 */
export function wallBudgetTimeoutNotice(
  requestedSeconds: number,
  grantedSeconds: number,
): string {
  const left = remainingMs();

  // Omitted rather than guessed when the deadline has been cleared between the
  // command starting and its error surfacing. `?? 0` would state "about 0s
  // remain" — a confident wrong number, where saying nothing is merely quiet.
  const remaining =
    left === undefined
      ? ""
      : ` About ${Math.max(0, Math.round(left / 1000))}s of the turn remain.`;

  return (
    `The turn's wall-clock budget ended this, not the ${requestedSeconds}s timeout ` +
    `requested: the budget allowed it only ${grantedSeconds}s.${remaining} ` +
    `Running it again with more time cannot work — the same clock cuts the next ` +
    `call shorter still. Spend what is left reporting where the work got to.`
  );
}
