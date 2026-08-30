/**
 * The second finish gate: an unattended turn that stops early, with budget in
 * hand, is asked once to prove it satisfied what was actually asked for.
 *
 * Two of three failed trials in a benchmark run ended exactly that way — one at
 * iteration 59 of 200 with 74% of its wall budget unused, having verified a
 * property the task never asked about. Nothing in the loop noticed, because the
 * only completion gate looked for edits that had gone unchecked, and these had
 * been checked. Three times.
 *
 * No tool is called in this file. Two other files in this directory mock the
 * tool module for the whole run, so the tool-dependent cases — the merge with
 * the verification reminder, the duplicate amnesty, and whether the gate was
 * acted on — live in `turnSummary.test.ts` beside that mock instead.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { agentLoop } from "../../../runtime/loop";
import {
  WALL_RESERVE_SEC,
  clearDeadline,
  remainingMs,
  setDeadline,
} from "../../../runtime/deadline";
import { createRuntimeTest } from "../shared/testHelpers";
import type { Message, ProviderClient, StreamEvent, TurnSummary } from "../../../config/types";

const ORIGINAL_ITERATIONS = process.env.WOOPCODE_MAX_ITERATIONS;
const ORIGINAL_WALL = process.env.WOOPCODE_MAX_WALL_SEC;

afterEach(() => {
  if (ORIGINAL_ITERATIONS === undefined) delete process.env.WOOPCODE_MAX_ITERATIONS;
  else process.env.WOOPCODE_MAX_ITERATIONS = ORIGINAL_ITERATIONS;

  if (ORIGINAL_WALL === undefined) delete process.env.WOOPCODE_MAX_WALL_SEC;
  else process.env.WOOPCODE_MAX_WALL_SEC = ORIGINAL_WALL;

  clearDeadline();
});

function summaryOf(callbacks: {
  getCallsByName(name: string): Array<{ args: any[] }>;
}): TurnSummary {
  const calls = callbacks.getCallsByName("onTurnSummary");
  expect(calls.length).toBe(1);
  return calls[0]!.args[0] as TurnSummary;
}

/** The gate's message, identified by its opening rather than by the whole text. */
const requirementAsks = (messages: Message[]) =>
  messages.filter(
    (m) => m.role === "user" && m.content.includes("go back to the task statement above"),
  );

/** A model that answers in words, calling nothing — the shape the gate exists for. */
function talkingProvider(replies: string[]): ProviderClient {
  let n = 0;
  return {
    async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: "text", content: replies[Math.min(n, replies.length - 1)]! };
      n++;
      yield { type: "done" } as StreamEvent;
    },
  } as unknown as ProviderClient;
}

async function runUnattended(
  provider: ProviderClient,
  options: { unattended?: boolean; useTools?: boolean } = {},
) {
  const { callbacks, messages } = createRuntimeTest();
  callbacks.onError = () => {};
  const text = await agentLoop(
    provider,
    messages,
    "",
    callbacks,
    undefined,
    options.useTools ?? true,
    { unattended: options.unattended ?? true },
  );
  return { text, messages, summary: summaryOf(callbacks) };
}

describe("the requirement gate", () => {
  test("an unattended turn that stops early is asked once", async () => {
    const { text, messages, summary } = await runUnattended(
      talkingProvider(["Done — the file builds cleanly.", "Confirmed, nothing left."]),
    );

    expect(requirementAsks(messages)).toHaveLength(1);
    expect(summary.requirementReminders).toBe(1);
    expect(text).toBe("Confirmed, nothing left.");
    // Asked and ignored: the model answered in prose without running anything,
    // which is this mechanism's likeliest failure and has to be visible in the
    // record rather than inferred from a score.
    expect(summary.requirementGateActedOn).toBe(false);
  });

  test("an attended turn is never asked", async () => {
    const { messages, summary } = await runUnattended(talkingProvider(["Done."]), {
      unattended: false,
    });

    // Somebody is reading the answer and can say what was missed for the cost
    // of one sentence, which is cheaper than a round trip.
    expect(requirementAsks(messages)).toHaveLength(0);
    expect(summary.requirementReminders).toBe(0);
    expect(summary.requirementGateActedOn).toBeUndefined();
  });

  test("a turn with no tools is never asked", async () => {
    const { messages, summary } = await runUnattended(talkingProvider(["Hello."]), {
      useTools: false,
    });

    // The conversational path is given no tools at all, so an instruction to
    // go and run a command is one the turn cannot carry out.
    expect(requirementAsks(messages)).toHaveLength(0);
    expect(summary.requirementReminders).toBe(0);
  });

  test("it is asked once, never twice", async () => {
    const { messages, summary } = await runUnattended(
      talkingProvider(["First answer.", "Second answer.", "Third answer."]),
    );

    expect(requirementAsks(messages)).toHaveLength(1);
    expect(summary.requirementReminders).toBe(1);
    expect(summary.iterations).toBe(2);
  });

  test("a turn without the budget to act on it is not asked", async () => {
    // Nine steps: one spent answering, eight left, and the gate needs ten. It
    // asks for work — enumerate the requirements, run a command per unproven
    // one — so asking without room to do it spends a round trip on nothing.
    process.env.WOOPCODE_MAX_ITERATIONS = "9";

    const { messages, summary } = await runUnattended(talkingProvider(["Done."]));

    expect(requirementAsks(messages)).toHaveLength(0);
    expect(summary.requirementReminders).toBe(0);
  });

  test("one step over the floor, it is asked", async () => {
    // The boundary from the other side, so the test above is pinned to the
    // floor rather than to any budget being small.
    process.env.WOOPCODE_MAX_ITERATIONS = "11";

    const { messages } = await runUnattended(talkingProvider(["Done.", "Confirmed."]));

    expect(requirementAsks(messages)).toHaveLength(1);
  });
});

/**
 * A turn that was warned it is winding down, and then was not.
 *
 * The wind-down count is derived from a rate measured on the turn itself, and a
 * rate moves: a slow patch early trips the warning, and the estimate recovers
 * once ordinary steps land beside it. `shouldWarnWindDown` re-arms only above
 * twice the threshold, so between ten and eleven steps the flag is still
 * latched while the count reads healthy — and the model is still under
 * "finish what you started, begin nothing new" from an earlier request.
 *
 * The gate must not contradict that, so it reads the flag as well as the count.
 */
describe("the requirement gate against the wind-down warning", () => {
  /**
   * Three slow steps, then free ones.
   *
   * Trips the warning at step four (40s left at 10s a step reads as four steps),
   * then holds the clock still so the mean falls as the iteration count climbs
   * and the estimate climbs back through the latch's re-arm point.
   */
  function pacedProvider(finishAt: number): ProviderClient {
    let n = 0;
    return {
      async *stream(): AsyncGenerator<StreamEvent> {
        n++;
        if (n <= 3) advance(10_000);

        yield { type: "text", content: `step ${n}` };
        if (n >= finishAt) {
          yield { type: "done" } as StreamEvent;
          return;
        }
        // Salvaged and resumed, so the turn continues without a tool.
        throw new Error("socket hang up");
      },
    } as unknown as ProviderClient;
  }

  let fakeNow = 0;
  const advance = (ms: number) => {
    fakeNow += ms;
  };

  /** Arms a 70s budget on a clock the test drives. */
  function armClock() {
    const wallSeconds = WALL_RESERVE_SEC + 70;
    setDeadline(wallSeconds);
    const deadlineAt = Date.now() + remainingMs()!;
    fakeNow = deadlineAt - 70_000;
    setDeadline(wallSeconds, { now: () => fakeNow });
    process.env.WOOPCODE_MAX_WALL_SEC = String(wallSeconds);
  }

  test("a turn still under the wind-down warning is not asked", async () => {
    armClock();

    // Finishing at step 8: ten steps' worth of clock left, which clears the
    // gate's floor, while the flag set at step four has not yet re-armed.
    const { messages, summary } = await runUnattended(pacedProvider(8));

    expect(summary.iterations).toBe(8);
    expect(requirementAsks(messages)).toHaveLength(0);
    expect(summary.requirementReminders).toBe(0);
  });

  test("once the estimate recovers and the warning clears, it is asked", async () => {
    armClock();

    // The same clock, the same rate, two steps later — by which point the
    // estimate has passed the re-arm point and the flag is down. The only
    // difference between this and the test above is the latch.
    const { messages, summary } = await runUnattended(pacedProvider(10));

    // Eleven, not ten: the eleventh iteration is the round trip the gate bought,
    // which is the whole point of it and the difference from the test above.
    expect(summary.iterations).toBe(11);
    expect(requirementAsks(messages)).toHaveLength(1);
    expect(summary.requirementReminders).toBe(1);
  });
});
