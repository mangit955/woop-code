/**
 * The mutable bookkeeping of a single turn.
 *
 * Extracted from `agentLoop`, where these were fifteen locals threaded through
 * a five-hundred-line body. Nothing here decides anything — the loop still owns
 * control flow — but every counter the turn summary reports lives in one place,
 * and the two predicates derived from them are written once instead of at each
 * site that needed them.
 */

import { classifyInvocation, toolEffect } from "./toolEffects";
import { now, remainingMs } from "./deadline";
import type { TurnSummary } from "../config/types";

/**
 * Completed iterations before the measured rate is believed.
 *
 * `meanStepMs` divides elapsed by iterations, so after one step the mean *is*
 * that step. CLAUDE.md records provider latency ranging 1,742ms to 90,002ms
 * within a single probe, so one slow first request is enough to make a turn
 * with hundreds of steps of budget look like it has five: at 115s for step one
 * against `job.yaml`'s 690s of usable wall, `floor(575000 / 115000)` is 5, and
 * the model is told to wrap up with ~280 steps actually affordable.
 *
 * Three, because the mean recovers fast once ordinary steps land beside the
 * spike — the same case at step four reads 18 — and because a threshold high
 * enough to smooth a 90s outlier completely would suppress the warning on any
 * turn short enough to need it early.
 */
const MIN_RATE_SAMPLES = 3;

/**
 * Steps left when the model is told the budget is running out.
 *
 * Steps rather than seconds, because the same constant has to serve both
 * budgets and a duration is the wrong shape across this task set: 120s is 16%
 * of `overfull-hbox`'s budget and 1% of `build-pov-ray`'s. Time is converted
 * into steps instead, at the rate this turn has actually been running at.
 */
export const REMAINING_ITERATIONS_WARNING = 5;

export class TurnState {
  /** Provider responses so far. One iteration may carry several tool calls, or none. */
  iterations = 0;

  /**
   * When the turn began, read from the deadline's clock rather than `Date`.
   *
   * The same clock the wall budget is measured on, so a test that injects one
   * moves both — an elapsed time taken from `Date.now()` while the deadline ran
   * on a fake would report a rate for a turn that never happened.
   */
  readonly startedAt = now();

  /**
   * Whether the model has been told this turn is winding down.
   *
   * A flag rather than the equality test it replaces (`iterations === budget -
   * REMAINING_ITERATIONS_WARNING`), because two budgets can each come into view
   * and an equality on one of them silently never fired when the ceiling was
   * below the warning distance.
   */
  windDownWarned = false;

  /**
   * Steps this turn has left, from whichever of its two budgets is closer.
   *
   * The wall budget is converted into steps at the rate the turn has been
   * running at, so one warning and one flag serve both. Before the first
   * iteration completes there is no rate to convert with, and the iteration
   * count stands alone — which is the right answer anyway, since no time has
   * been spent.
   *
   * The rate is ignored until `MIN_RATE_SAMPLES` steps have gone into it. The
   * iteration ceiling still applies throughout, so an early turn is never told
   * it has *more* than it has; what the guard withholds is only the ability of
   * one slow step to end a turn that has hours left.
   *
   * On `TurnState` rather than in `loop.ts`, beside `meanStepMs` and the flag
   * this feeds: it reads nothing of the loop's but the ceiling it is passed.
   */
  stepsRemaining(budget: number): number {
    const byIterations = budget - this.iterations;

    const mean = this.meanStepMs();
    const left = remainingMs();
    if (mean === undefined || left === undefined) return byIterations;
    if (this.iterations < MIN_RATE_SAMPLES) return byIterations;

    return Math.min(byIterations, Math.floor(left / mean));
  }

  /**
   * Should the model be told, now, that this turn is winding down?
   *
   * Owns both transitions of `windDownWarned`, because the interesting one is
   * the way back. The step count the clock contributes is derived from a rate
   * measured on this turn, and a rate moves: a slow patch early can trip the
   * warning, and a latch would leave the model winding down for the rest of a
   * turn it is nowhere near the end of — the failure the wall budget exists to
   * prevent, reached from the other side. `MIN_RATE_SAMPLES` in `loop.ts` keeps
   * most bad estimates out; this clears the ones that get through.
   *
   * Re-arming at twice the threshold rather than at the threshold, so a count
   * hovering on the boundary cannot warn, clear and warn again.
   */
  shouldWarnWindDown(stepsLeft: number): boolean {
    if (!this.windDownWarned) {
      if (stepsLeft > REMAINING_ITERATIONS_WARNING) return false;
      this.windDownWarned = true;
      return true;
    }

    if (stepsLeft > REMAINING_ITERATIONS_WARNING * 2) this.windDownWarned = false;
    return false;
  }

  /**
   * Tools actually run.
   *
   * Counted where tools execute rather than inferred from the iteration
   * counter, because one iteration can carry several calls — and because a
   * call that was skipped as a duplicate or refused by plan mode ran nothing
   * and must not be counted here.
   */
  toolCallsExecuted = 0;

  /** Provider requests retried. Reported for the turn so a slow run reads differently from a flaky one. */
  retries = 0;

  /** Iterations whose stream died after the model had spoken, and whose partial output was kept. */
  salvagedIterations = 0;

  /**
   * Turns asked to check their own edits before finishing.
   *
   * A benchmark run ended four of five trials having changed files with
   * nothing run afterwards to check them — one made four edits and ran zero
   * verifications across two hundred iterations. The model is told to verify
   * in the system prompt; nothing ever checked that it had.
   */
  verificationReminders = 0;

  /** How many times each tool ran, by name. */
  readonly toolCounts: Record<string, number> = {};

  /**
   * Calls already made, keyed by tool and arguments, for duplicate detection.
   *
   * Counts every *attempt*, including ones refused by plan mode: a third
   * identical try should be skipped as a repeat even though the first two
   * never reached a tool.
   */
  readonly executedTools = new Map<string, number>();

  /**
   * Verification tracking, counted in tool executions rather than iterations.
   *
   * A single iteration can edit a file and then run the tests, and the order
   * within it is the whole question — so a step counter advances per tool,
   * and the two marks below record where the last write and last check landed.
   */
  private toolStep = 0;
  lastWriteStep: number | undefined;
  lastShellStep: number | undefined;

  /** Repeats of one call, with identical arguments, before it is skipped. */
  seenCount(key: string): number {
    return this.executedTools.get(key) ?? 0;
  }

  /** Records an attempt at `key`, duplicate or not. */
  countAttempt(key: string): void {
    this.executedTools.set(key, this.seenCount(key) + 1);
  }

  /**
   * Records what a completed tool call did to the workspace.
   *
   * Called only after a tool has actually run: one that threw changed nothing,
   * and a declined edit ends the turn before reaching here, so neither counts
   * as a workspace change.
   */
  recordToolEffect(name: string, args: Record<string, unknown>): void {
    this.toolStep++;
    this.toolCounts[name] = (this.toolCounts[name] ?? 0) + 1;

    switch (toolEffect(name)) {
      case "write":
        this.lastWriteStep = this.toolStep;
        break;

      case "shell": {
        // Judged from the call, not the tool name. A benchmark run showed
        // the agent doing its real editing through run_terminal — `sed -i`,
        // `cat >> file` — which name-only classification recorded as
        // verification, the opposite of what it is. A `repl` call is judged
        // from its source for the same reason.
        const { writes, verifies } = classifyInvocation(args);

        // Order matters when a command does both: `sed -i f.c && make` edited
        // and then checked, and the check has to land afterwards for the edit
        // to count as verified.
        if (writes) this.lastWriteStep = this.toolStep;
        if (verifies) this.lastShellStep = writes ? ++this.toolStep : this.toolStep;
        break;
      }
    }
  }

  /**
   * Wall milliseconds one step of this turn costs, measured on this turn.
   *
   * Elapsed over iterations, deliberately **not** an average of the provider's
   * `durationMs`: a step is the request plus every tool it went on to run, and
   * the two differ by about half — `make-mips-interpreter` measured 1.77s of
   * provider time against 2.03s of wall per iteration.
   *
   * Undefined before an iteration has completed, and while no time has passed,
   * because neither can be divided into a rate. Callers read that as "no
   * estimate yet" and fall back to the iteration count.
   */
  meanStepMs(): number | undefined {
    const elapsed = now() - this.startedAt;
    if (this.iterations === 0 || elapsed <= 0) return undefined;
    return elapsed / this.iterations;
  }

  /**
   * Did this turn change files and then run nothing to check them?
   *
   * Read in two places — once to decide whether to ask the model to verify,
   * and again when the summary is emitted — which is why it is derived here
   * rather than written out at both.
   */
  hasUnverifiedEdits(): boolean {
    return (
      this.lastWriteStep !== undefined &&
      (this.lastShellStep === undefined || this.lastShellStep < this.lastWriteStep)
    );
  }

  /** The record emitted once per turn, however the turn ended. */
  toSummary(): TurnSummary {
    return {
      iterations: this.iterations,
      retries: this.retries,
      salvagedIterations: this.salvagedIterations,
      verificationReminders: this.verificationReminders,
      toolCalls: this.toolCallsExecuted,
      lastWriteStep: this.lastWriteStep,
      lastShellStep: this.lastShellStep,
      toolCounts: this.toolCounts,
      unverifiedEdits: this.hasUnverifiedEdits(),
    };
  }
}

/**
 * The key a call is deduplicated by.
 *
 * A shell command is normalised first, so trivially different spellings of the
 * same command collapse together: a leading `cd`, the several ways to say
 * "install", and runs of whitespace. Everything else is keyed on its arguments
 * verbatim.
 */
export function normalizeToolKey(
  name: string,
  args: Record<string, unknown>,
): string {
  if (name === "run_terminal" && args.command) {
    const normalized = String(args.command)
      .trim()
      .replace(/^cd\s+\S+\s+&&\s+/, "")
      .replace(/bun (add|install)/, "install")
      .replace(/npm (i|install)/, "install")
      .replace(/\s+/g, " ")
      .trim();
    return `run_terminal:${normalized}`;
  }

  return `${name}:${JSON.stringify(args)}`;
}
