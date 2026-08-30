import { describe, test, expect, afterEach } from "bun:test";
import {
  BudgetExhaustedError,
  IterationBudgetExhaustedError,
  WallBudgetExhaustedError,
  agentLoop,
  stepsRemaining,
} from "../../../runtime/loop";
import {
  WALL_RESERVE_SEC,
  clearDeadline,
  remainingMs,
  setDeadline,
} from "../../../runtime/deadline";
import { TurnState } from "../../../runtime/turnState";
import { EXIT_BUDGET_EXHAUSTED } from "../../../commands/agent";
import type { ProviderClient, StreamEvent } from "../../../config/types";
import { createRuntimeTest } from "../shared/testHelpers";

const ORIGINAL_WALL = process.env.WOOPCODE_MAX_WALL_SEC;
const ORIGINAL_ITERATIONS = process.env.WOOPCODE_MAX_ITERATIONS;

afterEach(() => {
  if (ORIGINAL_WALL === undefined) delete process.env.WOOPCODE_MAX_WALL_SEC;
  else process.env.WOOPCODE_MAX_WALL_SEC = ORIGINAL_WALL;

  if (ORIGINAL_ITERATIONS === undefined)
    delete process.env.WOOPCODE_MAX_ITERATIONS;
  else process.env.WOOPCODE_MAX_ITERATIONS = ORIGINAL_ITERATIONS;

  // Module state outlives a file. The loop clears the deadline on every exit,
  // but a test that armed one without running a turn has to take it back
  // itself — and the clock with it.
  clearDeadline();
});

/**
 * A provider that never volunteers to stop.
 *
 * Every response is cut off after the model has spoken, which the loop salvages
 * and continues from — so the turn runs forever until a budget ends it, without
 * calling a tool.
 *
 * No tool, deliberately. `iterationBudget.test.ts` mocks the tool module for
 * the whole run, so a file that reaches the registry to keep a turn going is a
 * file whose result depends on which other file ran first.
 */
function neverFinishingProvider(onIteration?: () => void): ProviderClient {
  return {
    async *stream(): AsyncGenerator<StreamEvent> {
      onIteration?.();
      yield { type: "text", content: "still working" };
      // Retryable, so the loop keeps what arrived and asks again rather than
      // ending the turn on the failure.
      throw new Error("socket hang up");
    },
  } as ProviderClient;
}

/** Runs a turn to whatever ends it, keeping the error and the transcript. */
async function runToEnd(provider: ProviderClient) {
  const { callbacks, messages } = createRuntimeTest();
  let reported: Error | undefined;
  callbacks.onError = (error: Error) => {
    reported = error;
  };

  let thrown: Error | undefined;
  try {
    await agentLoop(provider, messages, "", callbacks);
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }
  return { thrown, reported, messages };
}

/** The wind-down nudge pushed into the conversation. */
const windDownNotices = (messages: Array<{ role: string; content?: string }>) =>
  messages.filter(
    (message) =>
      message.role === "user" &&
      (message.content ?? "").includes("before this turn is stopped"),
  );

describe("the wall-clock budget", () => {
  test("a turn with no wall budget is unaffected", async () => {
    delete process.env.WOOPCODE_MAX_WALL_SEC;
    process.env.WOOPCODE_MAX_ITERATIONS = "3";

    const { thrown } = await runToEnd(neverFinishingProvider());

    // The iteration ceiling is still what ends it, and the message still names
    // the knob that bound.
    expect(thrown).toBeInstanceOf(IterationBudgetExhaustedError);
    expect(thrown?.message).toContain("WOOPCODE_MAX_ITERATIONS");
  });

  // A real budget on the real clock: the reserve is subtracted from it, so
  // anything at or below the reserve is already spent when the turn starts.
  test("a budget already spent stops the turn before it asks the provider", async () => {
    process.env.WOOPCODE_MAX_WALL_SEC = String(WALL_RESERVE_SEC);
    process.env.WOOPCODE_MAX_ITERATIONS = "40";

    let requests = 0;
    const { thrown, reported } = await runToEnd(
      neverFinishingProvider(() => {
        requests += 1;
      }),
    );

    expect(thrown).toBeInstanceOf(WallBudgetExhaustedError);
    // Reported through onError and then rethrown, the same path the iteration
    // ceiling takes.
    expect(reported).toBe(thrown!);
    expect(requests).toBe(0);
  });

  test("the error names its own knob, not the iteration one", async () => {
    process.env.WOOPCODE_MAX_WALL_SEC = "45";

    const { thrown } = await runToEnd(neverFinishingProvider());

    expect(thrown?.message).toContain("WOOPCODE_MAX_WALL_SEC");
    expect(thrown?.message).not.toContain("WOOPCODE_MAX_ITERATIONS");
    expect(thrown?.message).toContain("(45s");
  });

  test("a malformed budget is ignored rather than read as a deadline", async () => {
    process.env.WOOPCODE_MAX_WALL_SEC = "soon";
    process.env.WOOPCODE_MAX_ITERATIONS = "2";

    const { thrown } = await runToEnd(neverFinishingProvider());

    // Falling back to "no wall budget" and not to "out of time": a typo in a
    // job config must not end every turn at its first step.
    expect(thrown).toBeInstanceOf(IterationBudgetExhaustedError);
  });

  test("the deadline is never consulted through a checkpoint", async () => {
    process.env.WOOPCODE_MAX_WALL_SEC = String(WALL_RESERVE_SEC);
    process.env.WOOPCODE_MAX_ITERATIONS = "40";

    const { callbacks, messages } = createRuntimeTest();
    callbacks.onError = () => {};
    let asked = 0;
    callbacks.onBudgetExhausted = async () => {
      asked += 1;
      return "continue";
    };

    let thrown: unknown;
    try {
      await agentLoop(neverFinishingProvider(), messages, "", callbacks);
    } catch (error) {
      thrown = error;
    }

    // A handler exists, and the wall deadline still ends the turn without
    // putting a question in front of a clock that keeps running.
    expect(asked).toBe(0);
    expect(thrown).toBeInstanceOf(WallBudgetExhaustedError);
  });

  test("the deadline is disarmed when the turn ends", async () => {
    process.env.WOOPCODE_MAX_WALL_SEC = String(WALL_RESERVE_SEC);

    await runToEnd(neverFinishingProvider());

    // Left armed, a spent deadline follows the session into the next turn: the
    // wind-down would fire at its first step, and a clamped tool timeout would
    // be one second. The loop clears it in the `finally` every exit runs
    // through, so it is gone whichever way the turn ended — this one threw.
    expect(remainingMs()).toBeUndefined();

    // And a later turn that sets no budget of its own is unbudgeted again.
    delete process.env.WOOPCODE_MAX_WALL_SEC;
    process.env.WOOPCODE_MAX_ITERATIONS = "2";

    const { thrown } = await runToEnd(neverFinishingProvider());
    expect(thrown).toBeInstanceOf(IterationBudgetExhaustedError);
    expect(remainingMs()).toBeUndefined();
  });
});

/**
 * Both budgets end a turn the same way, and the exit code says so.
 *
 * 2 means "worked, did not finish, judge the result rather than treat this as a
 * crash", which is what a deadline produces just as much as a ceiling. A
 * distinct code would be booked as an exception by a harness not yet updated to
 * know it, dropping exactly those trials from the mean.
 */
describe("the exit-code contract", () => {
  test("both budgets answer to the type the exit code is read from", () => {
    expect(new WallBudgetExhaustedError(600)).toBeInstanceOf(
      BudgetExhaustedError,
    );
    expect(new IterationBudgetExhaustedError(40)).toBeInstanceOf(
      BudgetExhaustedError,
    );
    expect(EXIT_BUDGET_EXHAUSTED).toBe(2);
  });

  test("an ordinary failure is not mistaken for a spent budget", () => {
    expect(new Error("provider refused the request")).not.toBeInstanceOf(
      BudgetExhaustedError,
    );
  });
});

/**
 * The wind-down converts time into steps.
 *
 * Tested here rather than through a turn because the alternative is a real
 * clock and a real budget: driving the conversion end to end would mean a test
 * that waits minutes, and one that waits is one that fails on a loaded runner.
 */
describe("steps remaining", () => {
  /** A turn `iterations` steps in, each having taken `stepMs`. */
  function turnAt(iterations: number, stepMs: number, budgetSeconds: number) {
    let at = 0;
    setDeadline(budgetSeconds, { now: () => at, startedAt: 0 });
    const state = new TurnState();
    at = iterations * stepMs;
    state.iterations = iterations;
    return state;
  }

  test("the iteration ceiling answers while no time has been spent", () => {
    setDeadline(3_600, { now: () => 0, startedAt: 0 });
    const state = new TurnState();

    // Nothing has completed, so there is no rate to convert the clock with.
    expect(stepsRemaining(state, 40)).toBe(40);
  });

  test("an unbudgeted turn is counted in iterations alone", () => {
    const state = new TurnState();
    state.iterations = 35;

    expect(stepsRemaining(state, 40)).toBe(5);
  });

  test("the closer of the two budgets is what is reported", () => {
    // 660s less the 60s reserve is 600s of usable budget. Ten steps at 20s
    // each leaves 400s, which is twenty more steps — while the ceiling of 12
    // leaves only two.
    const state = turnAt(10, 20_000, 660);
    expect(stepsRemaining(state, 12)).toBe(2);

    // Same turn, a ceiling far away: now the clock is the binding one.
    expect(stepsRemaining(state, 1_000)).toBe(20);
  });

  test("a slower turn has fewer steps left in the same time", () => {
    // Twice the wall per step over the same elapsed time: 400s left at 40s a
    // step is ten, where 20s a step was twenty.
    const state = turnAt(5, 40_000, 660);
    expect(stepsRemaining(state, 1_000)).toBe(10);
  });

  test("time already overspent reads as no steps left", () => {
    const state = turnAt(10, 70_000, 660);

    // The loop throws before it gets here; the arithmetic must still not report
    // room that does not exist.
    expect(stepsRemaining(state, 1_000)).toBeLessThanOrEqual(0);
  });
});

describe("the wind-down warning", () => {
  test("it is sent once for a turn, however many steps it takes", async () => {
    process.env.WOOPCODE_MAX_ITERATIONS = "8";
    delete process.env.WOOPCODE_MAX_WALL_SEC;

    const { messages } = await runToEnd(neverFinishingProvider());

    // A flag, not an equality on the step count: it fires at the first step
    // inside the warning distance and stays quiet for the rest of them.
    expect(windDownNotices(messages)).toHaveLength(1);
    expect(windDownNotices(messages)[0]!.content).toContain("Only 5 more steps");
  });

  // The reset that fires it again for a turn the user extended is covered in
  // packages/tests/runtime/iterationBudget.test.ts, where the checkpoint that
  // raises the ceiling is exercised — a salvaged response continues before
  // reaching it, so this file's provider never gets there.
});
