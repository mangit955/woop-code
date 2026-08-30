/**
 * The task statement stays in the window for as long as the turn runs.
 *
 * `recentMessages` counts user messages, and the loop pushes user messages of
 * its own — a wind-down warning, a finish gate, a truncated-stream resume. Six
 * of those and the question being answered has left the request, while the
 * model is still working on it. A benchmark trial ran 200 iterations off one
 * prompt, so this is the ordinary case for a headless run rather than an edge.
 *
 * No tool is called anywhere in this file: two other files in this directory
 * mock the tool module for the whole run, and a file that reaches the registry
 * is a file whose result depends on which one ran first.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { agentLoop } from "../../../runtime/loop";
import { recentMessages, turnInitiatingIndex } from "../../../config/config";
import { createRuntimeTest } from "../shared/testHelpers";
import type { Message, ProviderClient, StreamEvent } from "../../../config/types";

const ORIGINAL_ITERATIONS = process.env.WOOPCODE_MAX_ITERATIONS;

afterEach(() => {
  if (ORIGINAL_ITERATIONS === undefined) delete process.env.WOOPCODE_MAX_ITERATIONS;
  else process.env.WOOPCODE_MAX_ITERATIONS = ORIGINAL_ITERATIONS;
});

const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content });
const attachment = (path: string): Message => ({
  role: "user",
  content: "The image requested above:",
  images: [{ path, mediaType: "image/png" }],
});

describe("finding the message that started the turn", () => {
  test("is the last conversation turn present", () => {
    const conversation = [user("one"), assistant("a"), user("two")];
    expect(turnInitiatingIndex(conversation)).toBe(2);
  });

  test("an attached image is not a turn", () => {
    // The loop follows read_image with a user message carrying the picture.
    // Nobody typed it, so pinning it would pin the loop's own plumbing.
    const conversation = [user("describe these"), attachment("/a.png")];
    expect(turnInitiatingIndex(conversation)).toBe(0);
  });

  test("a transcript with no conversation turn pins nothing", () => {
    expect(turnInitiatingIndex([assistant("unprompted")])).toBeUndefined();
    expect(turnInitiatingIndex([])).toBeUndefined();
  });
});

describe("pinning it into the window", () => {
  /** A task, then enough loop-pushed turns to push it out of a window of three. */
  const transcript: Message[] = [
    user("TASK: make the tests pass"),
    assistant("working"),
    user("Your previous message was cut off before it finished."),
    assistant("still working"),
    user("Only 5 more steps are available before this turn is stopped."),
    assistant("nearly there"),
    user("You changed files and have not run anything since."),
    assistant("done"),
  ];

  test("the task is carried back in once it falls out", () => {
    const windowed = recentMessages(transcript, 3, 0);

    expect(windowed[0]).toBe(transcript[0]!);
    expect(windowed.filter((m) => m === transcript[0]!)).toHaveLength(1);
  });

  test("without the pin the same window loses it", () => {
    // The defect itself, stated as a test: this is what every request after the
    // sixth injected message used to look like.
    expect(recentMessages(transcript, 3)).not.toContain(transcript[0]!);
  });

  /**
   * The one exception to the turn ceiling, stated as arithmetic.
   *
   * Everything else that budgets context treats `MAX_TURNS` as a hard boundary,
   * so the pin's cost is written down here rather than left to be discovered by
   * someone sizing a prompt from the constant alone: a pinned request carries
   * one more conversation turn than was asked for, and never two.
   */
  test("a pinned window carries exactly one turn more than the ceiling", () => {
    const turns = (messages: Message[]) =>
      messages.filter((m) => m.role === "user" && !m.images?.length).length;

    for (const maxTurns of [1, 2, 3]) {
      expect(turns(recentMessages(transcript, maxTurns, 0))).toBe(maxTurns + 1);
    }

    // And the ceiling is intact without a pin, which is what makes the line
    // above an exception rather than an off-by-one.
    for (const maxTurns of [1, 2, 3]) {
      expect(turns(recentMessages(transcript, maxTurns))).toBe(maxTurns);
    }
  });

  test("a window that already holds the task is untouched", () => {
    // Byte-identical to the unpinned assembly, so a short conversation — every
    // interactive turn, and the first several steps of a headless one — is
    // assembled exactly as it was before the pin existed.
    expect(recentMessages(transcript, 6, 0)).toEqual(recentMessages(transcript, 6));
  });

  test("an out-of-range pin is ignored rather than trusted", () => {
    expect(recentMessages(transcript, 3, -1)).toEqual(recentMessages(transcript, 3));
    expect(recentMessages(transcript, 3, 99)).toEqual(recentMessages(transcript, 3));
  });
});

/**
 * A provider that never volunteers to stop, and never finishes a response.
 *
 * Each iteration is salvaged and resumed, which pushes an assistant message and
 * a user message — so the transcript gains one conversation turn per step
 * without a tool ever running. That is the cheapest way to reproduce a long
 * turn's pressure on the window.
 */
function truncatingProvider(seen: Message[][]): ProviderClient {
  return {
    async *stream(messages: Message[]): AsyncGenerator<StreamEvent> {
      seen.push(messages);
      yield { type: "text", content: "still working" };
      throw new Error("socket hang up");
    },
  } as unknown as ProviderClient;
}

describe("a long turn, end to end", () => {
  test("every request still carries the task", async () => {
    process.env.WOOPCODE_MAX_ITERATIONS = "9";

    const { callbacks, messages } = createRuntimeTest();
    callbacks.onError = () => {};
    const task = "Test prompt";
    expect(messages[0]).toEqual(user(task));

    const seen: Message[][] = [];
    try {
      await agentLoop(truncatingProvider(seen), messages, "", callbacks);
    } catch {
      // The iteration ceiling ends it; the transcript is what is under test.
    }

    // Nine requests, each one a turn further from the prompt.
    expect(seen).toHaveLength(9);
    for (const request of seen) {
      expect(request.some((m) => m.role === "user" && m.content === task)).toBe(true);
    }

    // And the last one would have lost it: eight resumes is more than the six
    // turns the window keeps.
    const unpinned = recentMessages(messages, 6);
    expect(unpinned.some((m) => m.role === "user" && m.content === task)).toBe(false);
  });
});
