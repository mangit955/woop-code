import { describe, expect, test } from "bun:test";
import { TurnState, normalizeToolKey } from "./turnState";

/**
 * Both of these were reachable only through the whole agent loop before the
 * decomposition, which is why neither had a test of its own despite deciding
 * two things that matter: whether a repeated call is skipped, and whether the
 * turn is asked to verify its own edits.
 */

describe("normalizeToolKey", () => {
  test("keys a non-shell tool on its arguments", () => {
    expect(normalizeToolKey("read_file", { path: "a.ts" })).toBe(
      'read_file:{"path":"a.ts"}',
    );
  });

  test("distinguishes different arguments to the same tool", () => {
    expect(normalizeToolKey("read_file", { path: "a.ts" })).not.toBe(
      normalizeToolKey("read_file", { path: "b.ts" }),
    );
  });

  test("collapses a leading cd, so the same command in a subdirectory is one key", () => {
    expect(normalizeToolKey("run_terminal", { command: "cd src && bun test" })).toBe(
      normalizeToolKey("run_terminal", { command: "bun test" }),
    );
  });

  test("treats bun install and npm i as the same command", () => {
    expect(normalizeToolKey("run_terminal", { command: "bun install" })).toBe(
      normalizeToolKey("run_terminal", { command: "npm i" }),
    );
  });

  // KNOWN DEFECT, recorded rather than asserted as correct.
  //
  // `/npm (i|install)/` alternates leftmost-first, so "npm install" matches the
  // `i` branch and leaves "nstall" behind: the key becomes "installnstall". It
  // is still stable for a given input, so repeats of "npm install" are caught —
  // but it does not collapse with "bun install" the way the rule intends.
  //
  // Fixing it is a change to duplicate detection, not to packaging, so it is
  // deliberately not folded into the decomposition that exposed it. Swap the
  // alternation to `(install|i)` and this test flips to the line above.
  test("does NOT yet collapse \"npm install\" with \"bun install\" (see comment)", () => {
    expect(normalizeToolKey("run_terminal", { command: "npm install" })).toBe(
      "run_terminal:installnstall",
    );
    expect(normalizeToolKey("run_terminal", { command: "npm install" })).not.toBe(
      normalizeToolKey("run_terminal", { command: "bun install" }),
    );
  });

  test("collapses runs of whitespace", () => {
    expect(normalizeToolKey("run_terminal", { command: "bun    test   x" })).toBe(
      normalizeToolKey("run_terminal", { command: "bun test x" }),
    );
  });

  test("keeps genuinely different commands apart", () => {
    expect(normalizeToolKey("run_terminal", { command: "bun test" })).not.toBe(
      normalizeToolKey("run_terminal", { command: "bun run build" }),
    );
  });

  test("falls back to argument keying when run_terminal has no command", () => {
    expect(normalizeToolKey("run_terminal", {})).toBe("run_terminal:{}");
  });
});

describe("TurnState.hasUnverifiedEdits", () => {
  test("a turn that did nothing has no unverified edits", () => {
    expect(new TurnState().hasUnverifiedEdits()).toBe(false);
  });

  test("reading a file is not an edit", () => {
    const state = new TurnState();
    state.recordToolEffect("read_file", { path: "a.ts" });

    expect(state.hasUnverifiedEdits()).toBe(false);
  });

  test("a write with nothing after it is unverified", () => {
    const state = new TurnState();
    state.recordToolEffect("edit_file", { path: "a.ts" });

    expect(state.hasUnverifiedEdits()).toBe(true);
  });

  test("a write followed by a test run is verified", () => {
    const state = new TurnState();
    state.recordToolEffect("edit_file", { path: "a.ts" });
    state.recordToolEffect("run_terminal", { command: "bun test" });

    expect(state.hasUnverifiedEdits()).toBe(false);
  });

  test("a test run followed by a write is NOT verified — order is the whole question", () => {
    const state = new TurnState();
    state.recordToolEffect("run_terminal", { command: "bun test" });
    state.recordToolEffect("edit_file", { path: "a.ts" });

    expect(state.hasUnverifiedEdits()).toBe(true);
  });

  // The case name-only classification got backwards: the agent's real editing
  // went through run_terminal, and calling that "verification" inverted it.
  test("a shell command that writes counts as an edit, not a check", () => {
    const state = new TurnState();
    state.recordToolEffect("run_terminal", { command: "sed -i 's/a/b/' f.c" });

    expect(state.hasUnverifiedEdits()).toBe(true);
  });

  test("one command that edits and then checks counts as verified", () => {
    const state = new TurnState();
    state.recordToolEffect("run_terminal", { command: "sed -i 's/a/b/' f.c && make" });

    expect(state.hasUnverifiedEdits()).toBe(false);
  });
});

describe("TurnState bookkeeping", () => {
  test("counts attempts per key, independently", () => {
    const state = new TurnState();

    expect(state.seenCount("a")).toBe(0);
    state.countAttempt("a");
    state.countAttempt("a");
    state.countAttempt("b");

    expect(state.seenCount("a")).toBe(2);
    expect(state.seenCount("b")).toBe(1);
  });

  test("toSummary reports the counters and the derived verdict", () => {
    const state = new TurnState();
    state.iterations = 3;
    state.retries = 1;
    state.toolCallsExecuted = 2;
    state.recordToolEffect("edit_file", { path: "a.ts" });
    state.recordToolEffect("read_file", { path: "b.ts" });

    const summary = state.toSummary();

    expect(summary.iterations).toBe(3);
    expect(summary.retries).toBe(1);
    expect(summary.toolCalls).toBe(2);
    expect(summary.toolCounts).toEqual({ edit_file: 1, read_file: 1 });
    expect(summary.unverifiedEdits).toBe(true);
  });
});
