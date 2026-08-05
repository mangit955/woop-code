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
import type { TurnSummary } from "../config/types";

export class TurnState {
  /** Provider responses so far. One iteration may carry several tool calls, or none. */
  iterations = 0;

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
