import { describe, expect, test } from "bun:test";
import { UIStore } from "./ui-store";
import { ApprovalMode, DEFAULT_APPROVAL_MODE } from "../../../runtime/approval";

describe("UIStore conversation scrolling", () => {
  test("scrolls only within the measured transcript bounds", () => {
    const store = new UIStore();
    store.setScrollLimit(10);

    store.scrollUp();
    expect(store.getState().scrollOffset).toBe(1);

    store.pageUp();
    expect(store.getState().scrollOffset).toBe(9);

    store.pageUp();
    expect(store.getState().scrollOffset).toBe(10);

    store.scrollDown();
    expect(store.getState().scrollOffset).toBe(9);

    store.pageDown();
    expect(store.getState().scrollOffset).toBe(1);

    store.pageDown();
    expect(store.getState().scrollOffset).toBe(0);
  });

  test("clamps the position when the conversation or viewport shrinks", () => {
    const store = new UIStore();
    store.setScrollLimit(12);
    store.scrollToTop();
    expect(store.getState().scrollOffset).toBe(12);

    store.setScrollLimit(4);
    expect(store.getState().scrollOffset).toBe(4);
  });

  /**
   * The transcript used to reset to the bottom whenever anything was appended,
   * so reading a tool result mid-turn lasted until the next streamed token. The
   * offset is measured from the last line, so holding a position means moving
   * the number as the content grows — these cover both directions of that.
   */
  test("holds the reader's place while the turn keeps appending", () => {
    const store = new UIStore();
    store.setScrollLimit(20);
    store.pageUp();
    expect(store.getState().scrollOffset).toBe(8);

    // Six rows of tool output land below what is being read.
    store.setScrollLimit(26);
    expect(store.getState().scrollOffset).toBe(14);

    store.startTool({ id: "t1", name: "read_file", arguments: {} });
    store.appendAssistantText("more");
    expect(store.getState().scrollOffset).toBe(14);
  });

  test("follows the latest line while the reader is at the bottom", () => {
    const store = new UIStore();
    store.setScrollLimit(20);
    expect(store.getState().scrollOffset).toBe(0);

    store.setScrollLimit(40);
    expect(store.getState().scrollOffset).toBe(0);
    expect(store.isFollowing()).toBe(true);
  });

  test("scrolling back to the bottom starts following again", () => {
    const store = new UIStore();
    store.setScrollLimit(10);
    store.pageUp();
    expect(store.isFollowing()).toBe(false);

    store.pageDown();
    expect(store.isFollowing()).toBe(true);

    store.setScrollLimit(30);
    expect(store.getState().scrollOffset).toBe(0);
  });

  test("submitting a prompt returns to the latest line", () => {
    const store = new UIStore();
    store.setScrollLimit(20);
    store.scrollToTop();
    expect(store.getState().scrollOffset).toBe(20);

    store.addUserMessage("what changed?");
    expect(store.getState().scrollOffset).toBe(0);

    store.setScrollLimit(28);
    expect(store.getState().scrollOffset).toBe(0);
  });

  test("reports how far the transcript can scroll, for the scrollbar", () => {
    const store = new UIStore();
    store.setScrollLimit(17);
    expect(store.getState().maxScrollOffset).toBe(17);

    store.setScrollLimit(-3);
    expect(store.getState().maxScrollOffset).toBe(0);
  });
});

describe("UIStore edit approvals", () => {
  test("scrolls a diff from its first line toward its last line", () => {
    const store = new UIStore();
    store.setPendingEditScrollLimit(12);

    store.scrollPendingEditBy(3);
    expect(store.getState().pendingEditScrollOffset).toBe(3);

    store.scrollPendingEditBy(20);
    expect(store.getState().pendingEditScrollOffset).toBe(12);

    store.scrollPendingEditBy(-5);
    expect(store.getState().pendingEditScrollOffset).toBe(7);

    store.scrollPendingEditToStart();
    expect(store.getState().pendingEditScrollOffset).toBe(0);
  });

  test("exposes a pending edit until it is approved", async () => {
    const store = new UIStore();
    const pending = store.setPendingEdit({
      id: "edit-1",
      filePath: "src/example.ts",
      oldContent: "old",
      newContent: "new",
      diff: "@@ -1 +1 @@\n-old\n+new",
      toolCallId: "tool-1",
    });

    expect(store.getState().pendingEdit?.id).toBe("edit-1");
    store.approvePendingEdit();
    await expect(pending).resolves.toBe(true);
    expect(store.getState().pendingEdit).toBeNull();
  });

  test("marks a failed tool instead of leaving a spinner running", () => {
    const store = new UIStore();
    store.startTool({ id: "tool-1", name: "edit_file", arguments: {} });
    store.failTool("tool-1");

    expect(store.getState().timeline.at(-1)).toMatchObject({
      type: "tool",
      status: "failed",
    });
  });
});

describe("UIStore questions", () => {
  test("keeps the request pending until the user answers", async () => {
    const store = new UIStore();
    const pending = store.setPendingQuestion({
      id: "question-1",
      questions: ["Which database?"],
    });

    expect(store.getState().pendingQuestion?.questions).toEqual(["Which database?"]);
    store.answerPendingQuestion(["SQLite"]);

    await expect(pending).resolves.toEqual(["SQLite"]);
    expect(store.getState().pendingQuestion).toBeNull();
  });

  test("returns null when the user cancels", async () => {
    const store = new UIStore();
    const pending = store.setPendingQuestion({ id: "question-2", questions: ["Continue?"] });
    store.cancelPendingQuestion();
    await expect(pending).resolves.toBeNull();
  });
});

describe("UIStore headless mode", () => {
  const edit = {
    id: "edit-1",
    filePath: "src/example.ts",
    oldContent: "old",
    newContent: "new",
    diff: "@@ -1 +1 @@\n-old\n+new",
    toolCallId: "tool-1",
  };
  const command = { id: "cmd-1", command: "bun test", toolName: "run_tests" } as const;

  test("resolves approvals immediately instead of waiting for a TUI", async () => {
    const store = new UIStore();
    store.setNonInteractive({ autoApprove: true });

    await expect(store.setPendingEdit(edit)).resolves.toBe(true);
    await expect(store.setPendingCommand(command)).resolves.toBe(true);
    await expect(
      store.setPendingQuestion({ id: "q-1", questions: ["Which database?"] })
    ).resolves.toBeNull();

    // Nothing is rendered, so no approval state is left behind.
    expect(store.getState().pendingEdit).toBeNull();
    expect(store.getState().pendingCommand).toBeNull();
    expect(store.getState().pendingQuestion).toBeNull();
  });

  test("rejects approvals when auto-approve is disabled", async () => {
    const store = new UIStore();
    store.setNonInteractive({ autoApprove: false });

    await expect(store.setPendingEdit(edit)).resolves.toBe(false);
    await expect(store.setPendingCommand(command)).resolves.toBe(false);
  });

  test("never continues a turn on an absent user's behalf", async () => {
    const store = new UIStore();
    // Even here, where every other approval is granted: continuing is the one
    // answer that lets a stuck loop run unattended, which is the situation the
    // step ceiling exists for.
    store.setNonInteractive({ autoApprove: true });

    await expect(
      store.setPendingContinuation({ id: "cont-1", steps: 40 }),
    ).resolves.toBe(false);
    expect(store.getState().pendingContinuation).toBeNull();
  });
});

describe("UIStore turn continuation", () => {
  const continuation = { id: "cont-1", steps: 40 };

  test("resolves true when the user chooses to keep going", async () => {
    const store = new UIStore();
    const decision = store.setPendingContinuation(continuation);

    expect(store.getState().pendingContinuation).toEqual(continuation);

    store.continuePendingTurn();
    await expect(decision).resolves.toBe(true);
    expect(store.getState().pendingContinuation).toBeNull();
  });

  test("resolves false when the user stops the turn", async () => {
    const store = new UIStore();
    const decision = store.setPendingContinuation(continuation);

    store.stopPendingTurn();
    await expect(decision).resolves.toBe(false);
  });

  /**
   * Dismissing has to resolve, not just close. The loop is awaiting this
   * promise, so a dialog that vanished without answering would leave the turn
   * suspended with no way back to it.
   */
  test("dismissing the dialog stops the turn rather than hanging it", async () => {
    const store = new UIStore();
    const decision = store.setPendingContinuation(continuation);

    expect(store.hasOpenModal()).toBe(true);
    expect(store.dismissTopModal()).toBe(true);

    await expect(decision).resolves.toBe(false);
    expect(store.hasOpenModal()).toBe(false);
  });

  test("cancelling the session resolves a checkpoint left open", async () => {
    const store = new UIStore();
    const decision = store.setPendingContinuation(continuation);

    store.clearPendingContinuation();
    await expect(decision).resolves.toBe(false);
  });
});

describe("UIStore turn footer", () => {
  const turn = { agent: "Build", model: "gemini-2.0-flash", startedAt: 1_000 };

  test("keeps the running turn out of the timeline so it renders last", () => {
    const store = new UIStore();
    store.addUserMessage("explain this repo");
    store.startTurn(turn);

    // Held aside rather than appended: anything the turn adds next has to land
    // above the footer, not below it.
    expect(store.getState().activeTurn).toMatchObject(turn);
    expect(store.getState().timeline.map((item) => item.type)).toEqual(["user"]);
  });

  test("freezes the elapsed time into the timeline when the turn ends", () => {
    const store = new UIStore();
    store.addUserMessage("explain this repo");
    store.startTurn(turn);
    store.startTool({ id: "tool-1", name: "read_file", arguments: { path: "cli.ts" } });
    store.finishTurn("completed", 4_500);

    expect(store.getState().activeTurn).toBeNull();
    expect(store.getState().timeline.map((item) => item.type)).toEqual([
      "user",
      "tool",
      "turn",
    ]);

    const footer = store.getState().timeline.at(-1);
    expect(footer).toMatchObject({
      type: "turn",
      agent: "Build",
      model: "gemini-2.0-flash",
      startedAt: 1_000,
      endedAt: 4_500,
      outcome: "completed",
    });
  });

  test("records how the turn ended", () => {
    const store = new UIStore();

    store.startTurn(turn);
    store.finishTurn("cancelled", 2_000);
    store.startTurn({ ...turn, startedAt: 3_000 });
    store.finishTurn("error", 3_200);

    expect(
      store.getState().timeline.map((item) => item.type === "turn" && item.outcome),
    ).toEqual(["cancelled", "error"]);
  });

  test("ignores a finish without a turn in flight", () => {
    const store = new UIStore();
    store.finishTurn("completed");

    expect(store.getState().timeline).toEqual([]);
    expect(store.getState().activeTurn).toBeNull();
  });

  test("drops the running turn when the conversation is cleared", () => {
    const store = new UIStore();
    store.startTurn(turn);
    store.clearTimeline();

    expect(store.getState().activeTurn).toBeNull();
    expect(store.getState().timeline).toEqual([]);
  });
});

describe("UIStore modal dismissal", () => {
  const edit = {
    id: "edit-1",
    filePath: "cli.ts",
    oldContent: "a",
    newContent: "b",
    diff: "",
    toolCallId: "tool-1",
  };

  test("reports whether a modal owns the screen", () => {
    const store = new UIStore();
    expect(store.hasOpenModal()).toBe(false);

    store.openModelPicker();
    expect(store.hasOpenModal()).toBe(true);

    store.closeModelPicker();
    expect(store.hasOpenModal()).toBe(false);
  });

  test("closes the topmost modal in the order the app renders them", async () => {
    const store = new UIStore();
    const command = store.setPendingCommand({
      id: "cmd-1",
      command: "bun test",
      toolName: "run_tests",
    });
    store.openModelPicker();

    // The picker renders over the approval, so it is what Ctrl+C closes first.
    expect(store.dismissTopModal()).toBe(true);
    expect(store.getState().modelPickerOpen).toBe(false);
    expect(store.getState().pendingCommand).not.toBeNull();

    expect(store.dismissTopModal()).toBe(true);
    expect(store.getState().pendingCommand).toBeNull();
    // Dismissing answers the waiting tool rather than leaving it hanging.
    await expect(command).resolves.toBe(false);
  });

  test("resolves a dismissed approval as declined, not as an error", async () => {
    const store = new UIStore();
    const approval = store.setPendingEdit(edit);

    expect(store.dismissTopModal()).toBe(true);
    await expect(approval).resolves.toBe(false);
    expect(store.getState().pendingEdit).toBeNull();
  });

  test("answers a dismissed question with no answer", async () => {
    const store = new UIStore();
    const answer = store.setPendingQuestion({ id: "q-1", questions: ["Which database?"] });

    expect(store.dismissTopModal()).toBe(true);
    await expect(answer).resolves.toBeNull();
  });

  test("reports nothing to dismiss when no modal is open", () => {
    const store = new UIStore();
    expect(store.dismissTopModal()).toBe(false);
  });
});

describe("UIStore status resets", () => {
  const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test("a transient notice reverts to Ready on its own", async () => {
    const store = new UIStore();
    store.setTransientStatus("Cancelled", 20);

    expect(store.getState().status).toBe("Cancelled");

    await tick(60);
    expect(store.getState().status).toBe("Ready");
    expect(store.getState().isThinking).toBe(false);
  });

  test("a new request supersedes a pending reset", async () => {
    // The reported bug: a cancel scheduled Ready, the next turn set Thinking
    // directly without clearing that timer, and a second later the timer
    // relabelled the running turn Ready. The composer then looked idle while
    // the controller was still busy and refusing input.
    const store = new UIStore();
    store.setTransientStatus("Cancelled", 20);
    store.setStatus("Thinking...");

    await tick(60);
    expect(store.getState().status).toBe("Thinking...");
    expect(store.getState().isThinking).toBe(true);
  });

  test("an error notice cannot outlive the turn that follows it", async () => {
    const store = new UIStore();
    store.setTransientStatus("Error: rate limited", 30);
    store.setStatus("Thinking...");
    store.setStatus("Working...");

    await tick(70);
    expect(store.getState().status).toBe("Working...");
  });

  test("overlapping notices leave only the newest reset pending", async () => {
    const store = new UIStore();
    store.setTransientStatus("Error: first", 20);
    store.setTransientStatus("Cancelled", 90);

    // The first timer must not revert the notice that replaced it.
    await tick(50);
    expect(store.getState().status).toBe("Cancelled");

    await tick(70);
    expect(store.getState().status).toBe("Ready");
  });

  test("clearing a reset leaves the notice on screen", async () => {
    const store = new UIStore();
    store.setTransientStatus("Error: boom", 20);
    store.clearStatusReset();

    await tick(60);
    expect(store.getState().status).toBe("Error: boom");
  });

  test("starting a new conversation drops a pending reset", async () => {
    const store = new UIStore();
    store.setTransientStatus("Error: boom", 20);
    store.clearTimeline();
    store.setStatus("Thinking...");

    await tick(60);
    expect(store.getState().status).toBe("Thinking...");
  });
});

describe("UIStore approval mode", () => {
  test("starts on the default mode", () => {
    const store = new UIStore();

    expect(store.getState().approvalMode).toBe(DEFAULT_APPROVAL_MODE);
    expect(store.getState().approvalPickerOpen).toBe(false);
  });

  test("choosing a mode records it and closes the picker", () => {
    const store = new UIStore();
    store.openApprovalPicker();
    expect(store.hasOpenModal()).toBe(true);

    store.setApprovalMode(ApprovalMode.FULL_AUTO);

    expect(store.getState().approvalMode).toBe(ApprovalMode.FULL_AUTO);
    expect(store.getState().approvalPickerOpen).toBe(false);
    expect(store.hasOpenModal()).toBe(false);
  });

  test("the picker is dismissable like any other modal", () => {
    const store = new UIStore();
    store.openApprovalPicker();

    expect(store.dismissTopModal()).toBe(true);
    expect(store.getState().approvalPickerOpen).toBe(false);
  });
});

describe("UIStore command output", () => {
  test("keeps a command tool's output for its block", () => {
    const store = new UIStore();
    store.startTool({ id: "t1", name: "run_terminal", arguments: { command: "git status" } });
    store.finishTool("t1", { output: "On branch main" });

    expect(store.getState().timeline.at(-1)).toMatchObject({
      type: "tool",
      status: "completed",
      output: "On branch main",
    });
  });

  test("keeps a failed command's output too", () => {
    const store = new UIStore();
    store.startTool({ id: "t1", name: "run_tests", arguments: {} });
    store.failTool("t1", "1 fail");

    expect(store.getState().timeline.at(-1)).toMatchObject({
      type: "tool",
      status: "failed",
      output: "1 fail",
    });
  });
});

describe("UIStore session mode", () => {
  test("starts in Build, because plan mode is never persisted", () => {
    expect(new UIStore().getState().sessionMode).toBe("build");
  });

  test("Tab flips it, and reports the mode now in effect", () => {
    const store = new UIStore();

    expect(store.toggleSessionMode()).toBe("plan");
    expect(store.getState().sessionMode).toBe("plan");

    expect(store.toggleSessionMode()).toBe("build");
    expect(store.getState().sessionMode).toBe("build");
  });

  test("setting the mode already in effect notifies nobody", () => {
    const store = new UIStore();
    let notifications = 0;
    store.subscribe(() => notifications++);

    store.setSessionMode("plan");
    expect(notifications).toBe(1);

    store.setSessionMode("plan");
    expect(notifications).toBe(1);
  });

  test("clearing the timeline leaves the mode alone", () => {
    // The mode belongs to the session, not to the transcript: /new should not
    // quietly hand write access back.
    const store = new UIStore();
    store.setSessionMode("plan");
    store.clearTimeline();

    expect(store.getState().sessionMode).toBe("plan");
  });
});

describe("UIStore task list", () => {
  test("holds one list, replaced on each write", () => {
    const store = new UIStore();
    store.setTodos([{ content: "First", status: "in_progress" }]);
    store.setTodos([
      { content: "First", status: "completed" },
      { content: "Second", status: "in_progress" },
    ]);

    const todos = store.getState().timeline.filter((item) => item.type === "todo");
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({
      type: "todo",
      items: [
        { content: "First", status: "completed" },
        { content: "Second", status: "in_progress" },
      ],
    });
  });

  test("moves to the end so it sits beside the latest work", () => {
    const store = new UIStore();
    store.setTodos([{ content: "Step", status: "pending" }]);
    store.addUserMessage("something since");
    store.setTodos([{ content: "Step", status: "completed" }]);

    expect(store.getState().timeline.at(-1)?.type).toBe("todo");
    expect(store.getState().timeline.filter((item) => item.type === "todo")).toHaveLength(1);
  });

  test("clearing the timeline drops it", () => {
    const store = new UIStore();
    store.setTodos([{ content: "Step", status: "pending" }]);
    store.clearTimeline();

    expect(store.getState().timeline).toHaveLength(0);
  });
});

describe("UIStore blocked tools", () => {
  test("a refused call is marked blocked, not failed", () => {
    // Plan mode refusing a write is the mode working. Recording it as a failure
    // put a red row and a "failed:" line in front of the user every time the
    // feature did its job.
    const store = new UIStore();
    store.startTool({ id: "t1", name: "edit_file", arguments: { path: "cli.ts" } });
    store.blockTool("t1", "Plan mode");

    expect(store.getState().timeline.at(-1)).toMatchObject({
      type: "tool",
      status: "blocked",
      summary: "Plan mode",
    });
  });

  test("blocking adds no system message of its own", () => {
    const store = new UIStore();
    store.startTool({ id: "t1", name: "edit_file", arguments: { path: "cli.ts" } });
    store.blockTool("t1", "Plan mode");

    expect(store.getState().timeline.filter((item) => item.type === "system")).toHaveLength(0);
  });

  test("blocking a call that is not there changes nothing", () => {
    const store = new UIStore();
    store.blockTool("missing", "Plan mode");

    expect(store.getState().timeline).toHaveLength(0);
  });
});

describe("UIStore session picker", () => {
  test("counts as an open modal, so global keys stand aside", () => {
    const store = new UIStore();
    expect(store.hasOpenModal()).toBe(false);

    store.openSessionPicker();

    expect(store.hasOpenModal()).toBe(true);
  });

  test("esc closes it", () => {
    const store = new UIStore();
    store.openSessionPicker();

    expect(store.dismissTopModal()).toBe(true);
    expect(store.getState().sessionPickerOpen).toBe(false);
  });

  test("the model picker still takes precedence when both are open", () => {
    // Matches the order app.tsx renders them in; a mismatch would dismiss the
    // dialog underneath the one on screen.
    const store = new UIStore();
    store.openModelPicker();
    store.openSessionPicker();

    store.dismissTopModal();

    expect(store.getState().modelPickerOpen).toBe(false);
    expect(store.getState().sessionPickerOpen).toBe(true);
  });
});

describe("UIStore system messages", () => {
  test("an empty message is not appended", () => {
    // A command that only opens a dialog has nothing to say and returns "".
    // Appending it left a blank row in the transcript behind every /resume.
    const store = new UIStore();
    store.addSystemMessage("");
    store.addSystemMessage("   \n ");

    expect(store.getState().timeline).toHaveLength(0);
  });

  test("a real message is still appended", () => {
    const store = new UIStore();
    store.addSystemMessage("Resumed auth-work");

    expect(store.getState().timeline).toHaveLength(1);
  });
});

describe("UIStore hydrateTimeline", () => {
  test("redraws a stored conversation as user and assistant rows", () => {
    // Restored history used to be loaded into the controller and never
    // rendered, so a resumed session showed an empty screen over a
    // conversation the model could see.
    const store = new UIStore();

    store.hydrateTimeline([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ]);

    expect(store.getState().timeline).toMatchObject([
      { type: "user", content: "first" },
      { type: "assistant", content: "second", streaming: false },
    ]);
  });

  test("replaces whatever was on screen rather than appending to it", () => {
    const store = new UIStore();
    store.addUserMessage("from the session being left");

    store.hydrateTimeline([{ role: "user", content: "from the session resumed" }]);

    expect(store.getState().timeline).toHaveLength(1);
  });

  test("skips anything with no text to draw", () => {
    const store = new UIStore();

    store.hydrateTimeline([
      { role: "user", content: "kept" },
      { role: "assistant", content: "   " },
      { role: "tool", content: "tool output" },
      { role: "assistant_tool_call", toolName: "read_file" },
    ] as any);

    expect(store.getState().timeline).toHaveLength(1);
  });

  test("clears the usage meter, which described the previous conversation", () => {
    const store = new UIStore();
    store.setUsage(1234);

    store.hydrateTimeline([{ role: "user", content: "hi" }]);

    expect(store.getState().usage).toBeNull();
  });

  test("closes the picker that asked for it", () => {
    const store = new UIStore();
    store.openSessionPicker();

    store.hydrateTimeline([{ role: "user", content: "hi" }]);

    expect(store.getState().sessionPickerOpen).toBe(false);
  });
});
