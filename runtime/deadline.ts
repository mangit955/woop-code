/**
 * The wall clock the current turn is running against.
 *
 * The loop has only ever measured its budget in iterations, and the harness
 * that runs it enforces time — so a benchmark trial was killed by its own
 * 200th iteration at 406s of an 1800s budget, mid-work, while Harbor's own
 * timeout never fired. `docs/adr/0001-wall-clock-budget-for-the-agent-loop.md`
 * has the per-task measurements.
 *
 * Module state rather than a parameter on `Tool.execute`, for the reason
 * `runtime/sandbox/registry.ts` argues at length for the same shape: three
 * tools will need it, and threading it through would change the `Tool`
 * interface in `config/types.ts` and every tool's signature.
 *
 * `clampToBudget` has no caller yet. Until `run_terminal`, `run_tests` and
 * `repl` clamp against it the deadline is advisory — the loop checks the clock
 * between iterations, and a command started just inside the budget still runs
 * to its own 300s default. That wiring is deliberately a separate change.
 *
 * Unbudgeted until a turn says otherwise, so nothing changes for a session that
 * never sets `WOOPCODE_MAX_WALL_SEC`: every reader below answers "keep going"
 * and every timeout is passed through untouched.
 */

/**
 * Wall seconds held back from the budget the operator gave.
 *
 * The harness kills the process at the number in the task's `task.toml`, so the
 * loop has to stop before it — this covers the iteration in flight when the
 * deadline is noticed, the final assistant message, and the session write that
 * follows. A run that is hard-killed instead loses all three.
 *
 * It does **not** cover the ~90s provider spike CLAUDE.md records under
 * benchmarking. Reserving for that would spend a sixth of `overfull-hbox`'s
 * entire 750s budget on a case that fires rarely; one request that slow will
 * overrun this reserve and the harness will kill the process, which is the
 * behaviour that exists today for every run.
 */
export const WALL_RESERVE_SEC = 60;

/**
 * When this process began, captured at module load.
 *
 * The harness starts its clock at exec, so the loop counts from there too.
 * Counting from the turn instead would let a second interactive turn restart a
 * budget the harness is still spending down.
 */
const PROCESS_STARTED_AT = Date.now();

/**
 * The clock every reader here uses, and the seam that keeps `Date` alone.
 *
 * A test that stubbed the global would be stubbing it for the entire run —
 * `mock.module` cannot be undone, and this suite has been burned by that once
 * already. Injecting the clock is what makes elapsed time testable without it.
 */
let clock: () => number = Date.now;

/** Absolute time the turn must have stopped by, or unset when unbudgeted. */
let deadlineAt: number | undefined;

/**
 * Arms the deadline for a budget expressed in whole wall seconds.
 *
 * The reserve is subtracted **here**, not by the caller: `agent.py` forwards
 * Harbor's `timeout_sec` verbatim so a published number traces back to
 * `task.toml` with no arithmetic in between, which leaves the safety margin as
 * one constant in one repository.
 *
 * `now` and `startedAt` are for tests. Passing `now` installs the clock and
 * leaves it installed, so a later call from the loop — which passes neither —
 * keeps measuring against the same fake rather than silently reverting to the
 * real one mid-turn.
 */
export function setDeadline(
  budgetSeconds: number,
  options: { now?: () => number; startedAt?: number } = {},
): void {
  if (options.now) clock = options.now;

  const from = options.startedAt ?? PROCESS_STARTED_AT;
  // Floored at zero: a budget smaller than the reserve is already spent, which
  // is the honest answer, rather than a deadline placed before the process ran.
  const usable = Math.max(budgetSeconds - WALL_RESERVE_SEC, 0);
  deadlineAt = from + usable * 1000;
}

/** The current time on whichever clock is installed. */
export function now(): number {
  return clock();
}

/** Milliseconds left before the turn must stop, or undefined when unbudgeted. */
export function remainingMs(): number | undefined {
  return deadlineAt === undefined ? undefined : deadlineAt - clock();
}

/**
 * Is the turn out of time?
 *
 * False when unbudgeted, so a session that never opted in reads "keep going"
 * from every call site rather than ending on a deadline nobody set.
 */
export function deadlineReached(): boolean {
  const left = remainingMs();
  return left !== undefined && left <= 0;
}

/**
 * The timeout a command may actually have, given what is left of the budget.
 *
 * Without this the deadline is advisory: the loop checks the clock between
 * iterations, but a command started just inside the budget runs to its own
 * timeout regardless — `run_terminal` defaults to 300s, which is 40% of
 * `overfull-hbox`'s entire budget.
 *
 * Never less than one second. Zero or a negative timeout does not shorten a
 * command, it kills it before it starts and reports a failure that says nothing
 * about the clock having run out.
 */
export function clampToBudget(seconds: number): number {
  const left = remainingMs();
  if (left === undefined) return seconds;

  return Math.max(1, Math.min(seconds, Math.floor(left / 1000)));
}

/**
 * Back to an unbudgeted session on the real clock.
 *
 * Restores the clock as well as clearing the deadline: this is module state, so
 * a test that installed a fake and cleared only the deadline would leave every
 * later test in the run measuring against a clock that never moves.
 */
export function clearDeadline(): void {
  deadlineAt = undefined;
  clock = Date.now;
}
