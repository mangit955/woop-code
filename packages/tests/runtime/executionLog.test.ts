import { describe, test, expect } from "bun:test";
import {
  compactOutcome,
  recordsFrom,
  renderExecutionLog,
} from "../../../runtime/executionLog";
import {
  createAssistantToolCallMessage,
  createToolMessage,
  createUserMessage,
} from "../shared/factories";

describe("compacting an outcome", () => {
  test("a file read keeps its size, not its content", () => {
    // The agent can read the file again; what it needs to remember is that it
    // already looked.
    const outcome = compactOutcome("read_file", "a\nb\nc\nd");
    expect(outcome).toBe("4 lines");
  });

  /** Exactly what formatCommandResult writes. */
  function commandResult(exitCode: number, stdout: string, stderr = "") {
    return `Exit code: ${exitCode}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;
  }

  test("a successful command reports ok and its last stdout line", () => {
    const outcome = compactOutcome(
      "run_tests",
      commandResult(0, "running...\npass 41\n\n 2 fail, 41 pass\n"),
    );
    // Where a test summary, a build error and a stack trace's root cause land.
    expect(outcome).toBe("ok: 2 fail, 41 pass");
  });

  /**
   * The defect this rule exists for. A successful command with empty stderr
   * ends in the literal label "STDERR:", and taking the last non-empty line
   * recorded that as the outcome — 71% of a real execution log.
   */
  test("an empty stderr never becomes the outcome", () => {
    const outcome = compactOutcome("run_terminal", commandResult(0, "Created file\n"));
    expect(outcome).toBe("ok: Created file");
    expect(outcome).not.toContain("STDERR");
  });

  test("a silent success still says it succeeded", () => {
    expect(compactOutcome("run_terminal", commandResult(0, "", ""))).toBe("ok");
  });

  test("a failure reports the exit code and the error", () => {
    const outcome = compactOutcome(
      "run_terminal",
      commandResult(1, "", "sh: 1: git: not found"),
    );
    expect(outcome).toBe("exit 1: sh: 1: git: not found");
  });

  test("a failure with output only on stdout still reports it", () => {
    const outcome = compactOutcome(
      "run_tests",
      commandResult(1, "FAILED tests/test_outputs.py::test_vm_execution", ""),
    );
    expect(outcome).toBe("exit 1: FAILED tests/test_outputs.py::test_vm_execution");
  });

  test("plain text that is not a command result still compacts", () => {
    // Tool errors and non-command tools do not use the structured format.
    expect(compactOutcome("run_terminal", "Tool failed: timed out")).toContain(
      "Tool failed",
    );
  });

  test("a failure is kept as a failure", () => {
    expect(compactOutcome("edit_file", "Tool failed: oldText not found")).toContain(
      "Tool failed",
    );
  });

  test("outcomes are bounded", () => {
    expect(compactOutcome("run_terminal", "x".repeat(5_000)).length).toBeLessThan(
      200,
    );
  });

  test("empty output is recorded as such, not dropped", () => {
    expect(compactOutcome("run_terminal", "   ")).toBe("no output");
  });

  test("compaction is deterministic", () => {
    // Nothing here calls a model: the same transcript must always produce the
    // same context, or a rerun stops being reproducible.
    const output = "line one\nline two\nfinal line";
    expect(compactOutcome("run_tests", output)).toBe(
      compactOutcome("run_tests", output),
    );
  });
});

describe("building records from a turn", () => {
  test("pairs each call with its result", () => {
    const records = recordsFrom([
      createUserMessage("fix the parser"),
      createAssistantToolCallMessage("read_file", "c1", { path: "parser.ts" }),
      createToolMessage("read_file", "c1", "a\nb"),
      createAssistantToolCallMessage("run_tests", "c2", { command: "bun test" }),
      createToolMessage("run_tests", "c2", "1 fail"),
    ]);

    expect(records).toEqual([
      { iteration: 1, tool: "read_file", subject: "parser.ts", outcome: "2 lines" },
      { iteration: 2, tool: "run_tests", subject: "bun test", outcome: "1 fail" },
    ]);
  });

  test("a call with no result is not recorded", () => {
    // A turn cut off mid-tool has nothing to say about how it came out.
    const records = recordsFrom([
      createAssistantToolCallMessage("read_file", "c1", { path: "a.ts" }),
    ]);
    expect(records).toEqual([]);
  });

  test("a conversation with no tools yields nothing", () => {
    expect(recordsFrom([createUserMessage("hello")])).toEqual([]);
  });

  test("numbering continues from where the session left off", () => {
    const records = recordsFrom(
      [
        createAssistantToolCallMessage("glob", "c9", { pattern: "**/*.ts" }),
        createToolMessage("glob", "c9", "one\ntwo"),
      ],
      7,
    );
    expect(records[0]!.iteration).toBe(7);
  });
});

describe("rendering the log", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    iteration: i + 1,
    tool: "read_file",
    subject: `file-${i}.ts`,
    outcome: "10 lines",
  }));

  test("nothing to report renders nothing", () => {
    expect(renderExecutionLog([], 500)).toBe("");
  });

  test("keeps the most recent actions when the budget bites", () => {
    const rendered = renderExecutionLog(many, 200);

    // What the agent did most recently is what it needs to not repeat.
    expect(rendered).toContain("file-39.ts");
    expect(rendered).not.toContain("file-0.ts");
  });

  test("says how many earlier actions were dropped", () => {
    expect(renderExecutionLog(many, 200)).toMatch(/\d+ earlier actions omitted/);
  });

  test("respects the character budget", () => {
    // Bounded by characters, not by a record count: twenty file reads and
    // twenty long shell commands are not the same amount of context.
    const rendered = renderExecutionLog(many, 300);
    expect(rendered.length).toBeLessThan(300 + 120);
  });

  test("a budget too small for even one line renders nothing", () => {
    expect(renderExecutionLog(many, 5)).toBe("");
  });

  test("tells the model what the list is for", () => {
    const rendered = renderExecutionLog(many.slice(0, 2), 500);
    expect(rendered).toContain("do not repeat it");
  });
});
