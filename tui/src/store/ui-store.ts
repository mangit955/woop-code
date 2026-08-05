import type { Listener, PendingCommand, PendingContinuation, PendingEdit, PendingQuestion, TimeLineItem, TurnIdentity, TurnOutcome, UIState } from "../types";
import type { TodoItem, ToolCall } from "../../../config/types";
import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from "../../../runtime/approval";
import { nextSessionMode, type SessionMode } from "../../../runtime/planMode";

/** The idle status, and what a transient status reverts to. */
export const READY_STATUS = "Ready";

export class UIStore {
  private state: UIState = {
    timeline: [],
    activeTurn: null,
    status: READY_STATUS,
    isThinking: false,
    modelPickerOpen: false,
    approvalMode: DEFAULT_APPROVAL_MODE,
    approvalPickerOpen: false,
    sessionPickerOpen: false,
    // A session always starts able to work. Plan mode is deliberately not
    // persisted: a mode that survived a restart would silently swallow the first
    // edit of the next session.
    sessionMode: "build",
    selectedModel: null,
    pendingEdit: null,
    pendingCommand: null,
    pendingQuestion: null,
    pendingContinuation: null,
    pendingEditScrollOffset: 0,
    scrollOffset: 0,
    maxScrollOffset: 0,
    maxPendingEditScrollOffset: 0,
    usage: null,
  };
  private listeners: Set<Listener> = new Set();
  private activeAssistantId: string | null = null;
  private pendingEmit = false;
  /**
   * Whether the transcript is pinned to its latest line.
   *
   * Appending used to reset `scrollOffset` to 0 outright, so scrolling up to
   * read a tool result mid-turn survived exactly until the next streamed token
   * yanked the view back down. The offset is now left alone while the user is
   * reading, and only `setScrollLimit` — the one place that learns how much the
   * content grew — moves it, to hold the same lines on screen.
   */
  private follow = true;
  private editResolvers: Map<
    string,
    { resolve: (approved: boolean) => void; reject: (error: Error) => void }
  > = new Map();
  private commandResolvers: Map<string, { resolve: (approved: boolean) => void }> = new Map();
  private questionResolvers: Map<string, { resolve: (answers: string[] | null) => void }> = new Map();
  private continuationResolvers: Map<string, { resolve: (shouldContinue: boolean) => void }> =
    new Map();
  private nonInteractive = false;
  private nonInteractiveApproval = false;
  private statusResetTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Headless runs (`woopcode -p "..."`) have no TUI to render approval
   * prompts, so every pending edit/command would otherwise hang forever.
   * In this mode approvals resolve immediately with a fixed answer and
   * questions to the user are declined.
   */
  setNonInteractive(options: { autoApprove: boolean }) {
    this.nonInteractive = true;
    this.nonInteractiveApproval = options.autoApprove;
  }

  isNonInteractive() {
    return this.nonInteractive;
  }

  getState() {
    return this.state;
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }

  // Batches rapid successive emissions (e.g. streaming tokens) into a single
  // render tick. Non-streaming callers use emit() directly so they stay instant.
  private emitBatched() {
    if (this.pendingEmit) return;
    this.pendingEmit = true;
    queueMicrotask(() => {
      this.pendingEmit = false;
      this.emit();
    });
  }

  addUserMessage(content: string) {
    // The one append that does jump to the bottom: submitting a prompt is a
    // statement that you want to watch what it does.
    this.follow = true;
    this.state = {
      ...this.state,
      scrollOffset: 0,
      timeline: [
        ...this.state.timeline,
        {
          id: crypto.randomUUID(),
          type: "user",
          content,
        },
      ],
    };

    this.emit();
  }

  /**
   * Opens the footer that reports agent, model, and elapsed time for the turn
   * about to run. It lives outside the timeline while in flight so it stays
   * below whatever the turn appends next.
   */
  startTurn(turn: TurnIdentity) {
    this.state = {
      ...this.state,
      activeTurn: { id: crypto.randomUUID(), ...turn },
      // Cleared rather than carried over: the meter reports the prompt the
      // *current* turn is sending, and a stale number beside a new turn reads
      // as a measurement of it.
      usage: null,
    };

    this.emit();
  }

  /**
   * Records what the last provider request cost.
   *
   * Only the prompt side is kept. That is the number the context window is
   * spent on and the one a user can act on by clearing the conversation;
   * completion tokens are gone the moment they are rendered.
   */
  setUsage(promptTokens: number | undefined) {
    if (promptTokens === undefined) return;
    if (this.state.usage?.promptTokens === promptTokens) return;

    this.state = { ...this.state, usage: { promptTokens } };
    this.emit();
  }

  /**
   * Freezes the footer into the timeline at the position it reached, so the
   * final elapsed time stays readable in scrollback while the next turn starts
   * its own footer below it.
   */
  finishTurn(outcome: TurnOutcome, endedAt = Date.now()) {
    const active = this.state.activeTurn;
    if (!active) return;

    const { id, ...identity } = active;

    this.state = {
      ...this.state,
      activeTurn: null,
      timeline: [
        ...this.state.timeline,
        {
          id,
          type: "turn",
          ...identity,
          endedAt,
          outcome,
        },
      ],
    };

    this.emit();
  }

  addSystemMessage(content: string) {
    // A command that opens a dialog has nothing to say in the transcript, and
    // returns "" to say so. Appending it would leave a blank row behind every
    // such command.
    if (!content.trim()) return;

    this.state = {
      ...this.state,
      timeline: [
        ...this.state.timeline,
        {
          id: crypto.randomUUID(),
          type: "system",
          content,
        },
      ],
    };

    this.emit();
  }

  startTool(tool: ToolCall) {
    this.state = {
      ...this.state,
      timeline: [
        ...this.state.timeline,
        {
          id: tool.id,
          type: "tool",
          name: tool.name,
          arguments: tool.arguments,
          status: "running",
        },
      ],
    };

    this.emit();
  }

  finishTool(id: string, result?: { summary?: string; output?: string }) {
    const tool = this.state.timeline.find(
      (item): item is Extract<TimeLineItem, { type: "tool" }> =>
        item.type === "tool" && item.id === id,
    );

    if (!tool) return;

    this.state = {
      ...this.state,
      timeline: this.state.timeline.map((item) =>
        item.type === "tool" && item.id === id
          ? {
              ...item,
              status: "completed",
              summary: result?.summary,
              output: result?.output,
            }
          : item,
      ),
    };

    this.emit();
  }

  /**
   * Marks a call the policy refused, which is not the same as one that failed.
   * The reason rides in `summary`, so the row reads `± Edit "cli.ts" (plan mode)`
   * rather than announcing an error that did not happen.
   */
  blockTool(id: string, reason: string) {
    this.state = {
      ...this.state,
      timeline: this.state.timeline.map((item) =>
        item.type === "tool" && item.id === id
          ? { ...item, status: "blocked", summary: reason }
          : item,
      ),
    };
    this.emit();
  }

  failTool(id: string, output?: string) {
    this.state = {
      ...this.state,
      timeline: this.state.timeline.map((item) =>
        item.type === "tool" && item.id === id
          ? { ...item, status: "failed", output }
          : item,
      ),
    };
    this.emit();
  }

  openApprovalPicker() {
    this.state = { ...this.state, approvalPickerOpen: true };
    this.emit();
  }

  closeApprovalPicker() {
    this.state = { ...this.state, approvalPickerOpen: false };
    this.emit();
  }

  setApprovalMode(mode: ApprovalMode) {
    this.state = { ...this.state, approvalMode: mode, approvalPickerOpen: false };
    this.emit();
  }

  setSessionMode(mode: SessionMode) {
    if (this.state.sessionMode === mode) return;

    this.state = { ...this.state, sessionMode: mode };
    this.emit();
  }

  /** What Tab does. Returns the mode now in effect, for the caller to apply. */
  toggleSessionMode(): SessionMode {
    const mode = nextSessionMode(this.state.sessionMode);
    this.setSessionMode(mode);
    return mode;
  }

  /**
   * Replaces the agent's task list.
   *
   * One list per session, not one per call: the tool sends the whole list every
   * time, so a new entry each call would stack near-identical checklists down the
   * transcript. The existing item is dropped and a fresh one appended, which
   * keeps the list current *and* keeps it beside the work it describes rather
   * than stranded above everything that happened since.
   */
  setTodos(items: TodoItem[]) {
    const withoutPrevious = this.state.timeline.filter((item) => item.type !== "todo");

    this.state = {
      ...this.state,
      timeline: [
        ...withoutPrevious,
        { id: crypto.randomUUID(), type: "todo", items },
      ],
    };

    this.emit();
  }

  startAssistantMessage() {
    const id = crypto.randomUUID();
    this.activeAssistantId = id;

    this.state = {
      ...this.state,
      timeline: [
        ...this.state.timeline,
        {
          id,
          type: "assistant",
          content: "",
          streaming: true,
        },
      ],
    };

    this.emit();
  }

  appendAssistantText(text: string) {
    if (!this.activeAssistantId) {
      this.startAssistantMessage();
    }

    // Mutate content in-place to avoid allocating a new array on every token.
    // The state reference is still replaced so useSyncExternalStore detects the change.
    const timeline = this.state.timeline;
    const idx = timeline.findIndex(
      (item) => item.type === "assistant" && item.id === this.activeAssistantId,
    );
    if (idx !== -1) {
      const item = timeline[idx] as Extract<TimeLineItem, { type: "assistant" }>;
      timeline[idx] = { ...item, content: item.content + text };
    }
    // Replace state reference so React sees a new snapshot
    // Also clear isThinking — first token arrived
    this.state = { ...this.state, timeline, isThinking: false };

    this.emitBatched();
  }

  finishAssistantMessage() {
    this.state = {
      ...this.state,
      timeline: this.state.timeline.map((item) =>
        item.type === "assistant" && item.id === this.activeAssistantId
          ? {
              ...item,
              streaming: false,
            }
          : item,
      ),
    };

    this.activeAssistantId = null;

    this.emit();
  }

  /**
   * Writes the status and cancels any scheduled reset.
   *
   * The cancellation is the point. Error and cancellation statuses revert to
   * Ready on a timer, and that timer used to live in a closure the controller
   * could not reach — so a turn starting within the window kept running while
   * the old timer relabelled it Ready. The composer then looked idle and
   * silently refused input, because the controller was still busy. Making every
   * write supersede a pending reset fixes it for all callers, present and
   * future, rather than for the one that happened to be reported.
   */
  setStatus(status: string) {
    this.clearStatusReset();
    this.applyStatus(status);
  }

  /**
   * A status that reverts to Ready after `resetAfterMs` unless something else
   * happens first — used for terminal notices the user should have a moment to
   * read. Replaces any reset already pending.
   */
  setTransientStatus(status: string, resetAfterMs: number) {
    this.setStatus(status);

    this.statusResetTimer = setTimeout(() => {
      this.statusResetTimer = null;
      // Only revert what this timer actually set. Belt and braces next to the
      // clearing above, and it keeps a late timer from touching a status that
      // has since moved on.
      if (this.state.status !== status) return;
      this.applyStatus(READY_STATUS);
    }, resetAfterMs);

    // A pending reset must never hold the process open on its own.
    this.statusResetTimer.unref?.();
  }

  /** Drops a pending reset, leaving the current status in place. */
  clearStatusReset() {
    if (!this.statusResetTimer) return;

    clearTimeout(this.statusResetTimer);
    this.statusResetTimer = null;
  }

  private applyStatus(status: string) {
    const isThinking = status.toLowerCase().includes("thinking");
    this.state = { ...this.state, status, isThinking };
    this.emit();
  }

  openModelPicker() {
    this.state = { ...this.state, modelPickerOpen: true };
    this.emit();
  }

  closeModelPicker() {
    this.state = { ...this.state, modelPickerOpen: false };
    this.emit();
  }

  setSelectedModel(model: string) {
    this.state = { ...this.state, selectedModel: model, modelPickerOpen: false };
    this.emit();
  }

  openSessionPicker() {
    this.state = { ...this.state, sessionPickerOpen: true };
    this.emit();
  }

  closeSessionPicker() {
    this.state = { ...this.state, sessionPickerOpen: false };
    this.emit();
  }

  /**
   * Redraws the transcript from a stored conversation.
   *
   * Restored history used to be loaded into the controller and never rendered,
   * so relaunching showed an empty screen over a conversation the model could
   * see — which reads as history having been lost. Only user and assistant
   * messages exist on disk (tool traffic is deliberately not persisted), so
   * this is the whole of what a resumed transcript can show.
   */
  hydrateTimeline(messages: readonly { role: string; content?: unknown }[]) {
    const items: TimeLineItem[] = [];

    for (const message of messages) {
      if (typeof message.content !== "string" || !message.content.trim()) continue;
      if (message.role === "user") {
        items.push({ id: crypto.randomUUID(), type: "user", content: message.content });
      } else if (message.role === "assistant") {
        items.push({
          id: crypto.randomUUID(),
          type: "assistant",
          content: message.content,
          streaming: false,
        });
      }
    }

    this.follow = true;
    this.state = {
      ...this.state,
      timeline: items,
      activeTurn: null,
      scrollOffset: 0,
      maxScrollOffset: 0,
      // The meter reports the prompt the current turn sends. A number carried
      // over from the session being left would describe the wrong conversation.
      usage: null,
      sessionPickerOpen: false,
    };
    this.activeAssistantId = null;
    this.emit();
  }

  // Pending Edit Management
  setPendingEdit(edit: PendingEdit): Promise<boolean> {
    if (this.nonInteractive) {
      return Promise.resolve(this.nonInteractiveApproval);
    }

    this.state = {
      ...this.state,
      pendingEdit: edit,
      pendingEditScrollOffset: 0,
      maxPendingEditScrollOffset: 0,
    };
    this.emit();

    return new Promise((resolve, reject) => {
      this.editResolvers.set(edit.id, { resolve, reject });
    });
  }

  approvePendingEdit() {
    const edit = this.state.pendingEdit;
    if (!edit) return;

    const resolver = this.editResolvers.get(edit.id);
    if (resolver) {
      resolver.resolve(true);
      this.editResolvers.delete(edit.id);
    }

    this.state = {
      ...this.state,
      pendingEdit: null,
      pendingEditScrollOffset: 0,
    };
    this.emit();
  }

  rejectPendingEdit() {
    const edit = this.state.pendingEdit;
    if (!edit) return;

    const resolver = this.editResolvers.get(edit.id);
    if (resolver) {
      resolver.resolve(false);
      this.editResolvers.delete(edit.id);
    }

    this.state = {
      ...this.state,
      pendingEdit: null,
      pendingEditScrollOffset: 0,
    };
    this.emit();
  }

  clearPendingEdit() {
    const edit = this.state.pendingEdit;
    if (!edit) return;

    const resolver = this.editResolvers.get(edit.id);
    if (resolver) {
      resolver.reject(new Error("Edit cancelled"));
      this.editResolvers.delete(edit.id);
    }

    this.state = {
      ...this.state,
      pendingEdit: null,
      pendingEditScrollOffset: 0,
    };
    this.emit();
  }

  setPendingCommand(command: PendingCommand): Promise<boolean> {
    if (this.nonInteractive) {
      return Promise.resolve(this.nonInteractiveApproval);
    }

    this.state = { ...this.state, pendingCommand: command };
    this.emit();

    return new Promise((resolve) => {
      this.commandResolvers.set(command.id, { resolve });
    });
  }

  approvePendingCommand() {
    this.resolvePendingCommand(true);
  }

  rejectPendingCommand() {
    this.resolvePendingCommand(false);
  }

  clearPendingCommand() {
    this.resolvePendingCommand(false);
  }

  private resolvePendingCommand(approved: boolean) {
    const command = this.state.pendingCommand;
    if (!command) return;

    this.commandResolvers.get(command.id)?.resolve(approved);
    this.commandResolvers.delete(command.id);
    this.state = { ...this.state, pendingCommand: null };
    this.emit();
  }

  setPendingQuestion(question: PendingQuestion): Promise<string[] | null> {
    // Nobody is at the keyboard in headless mode; the tool reports the
    // declined answer back to the model instead of blocking.
    if (this.nonInteractive) {
      return Promise.resolve(null);
    }

    this.state = { ...this.state, pendingQuestion: question };
    this.emit();

    return new Promise((resolve) => {
      this.questionResolvers.set(question.id, { resolve });
    });
  }

  answerPendingQuestion(answers: string[]) {
    this.resolvePendingQuestion(answers);
  }

  cancelPendingQuestion() {
    this.resolvePendingQuestion(null);
  }

  private resolvePendingQuestion(answers: string[] | null) {
    const question = this.state.pendingQuestion;
    if (!question) return;

    this.questionResolvers.get(question.id)?.resolve(answers);
    this.questionResolvers.delete(question.id);
    this.state = { ...this.state, pendingQuestion: null };
    this.emit();
  }

  /**
   * Asks whether a turn that has spent its budget should carry on.
   *
   * Declines rather than blocking when nobody is at the keyboard. Answering
   * "continue" for an absent user is the one wrong answer available: it is the
   * case where a stuck loop runs unattended, which is the whole reason a
   * ceiling exists.
   */
  setPendingContinuation(continuation: PendingContinuation): Promise<boolean> {
    if (this.nonInteractive) {
      return Promise.resolve(false);
    }

    this.state = { ...this.state, pendingContinuation: continuation };
    this.emit();

    return new Promise((resolve) => {
      this.continuationResolvers.set(continuation.id, { resolve });
    });
  }

  continuePendingTurn() {
    this.resolvePendingContinuation(true);
  }

  stopPendingTurn() {
    this.resolvePendingContinuation(false);
  }

  /** Dismissed without an answer — the turn stops, as with any other modal. */
  clearPendingContinuation() {
    this.resolvePendingContinuation(false);
  }

  private resolvePendingContinuation(shouldContinue: boolean) {
    const continuation = this.state.pendingContinuation;
    if (!continuation) return;

    this.continuationResolvers.get(continuation.id)?.resolve(shouldContinue);
    this.continuationResolvers.delete(continuation.id);
    this.state = { ...this.state, pendingContinuation: null };
    this.emit();
  }

  /** True when a modal owns the screen, so global keys can tell. */
  hasOpenModal() {
    const {
      modelPickerOpen,
      approvalPickerOpen,
      sessionPickerOpen,
      pendingCommand,
      pendingQuestion,
      pendingContinuation,
      pendingEdit,
    } = this.state;
    return (
      modelPickerOpen ||
      approvalPickerOpen ||
      sessionPickerOpen ||
      pendingCommand !== null ||
      pendingQuestion !== null ||
      pendingContinuation !== null ||
      pendingEdit !== null
    );
  }

  /**
   * Closes whichever modal is on top, in the order the app renders them, and
   * reports whether there was anything to close. Approvals resolve as declined
   * rather than rejecting: the user dismissed the window, which is an answer,
   * not a failure the tool should hear about as an error.
   */
  dismissTopModal() {
    if (this.state.modelPickerOpen) {
      this.closeModelPicker();
      return true;
    }
    if (this.state.approvalPickerOpen) {
      this.closeApprovalPicker();
      return true;
    }
    if (this.state.sessionPickerOpen) {
      this.closeSessionPicker();
      return true;
    }
    if (this.state.pendingCommand) {
      this.rejectPendingCommand();
      return true;
    }
    if (this.state.pendingQuestion) {
      this.cancelPendingQuestion();
      return true;
    }
    if (this.state.pendingContinuation) {
      this.clearPendingContinuation();
      return true;
    }
    if (this.state.pendingEdit) {
      this.rejectPendingEdit();
      return true;
    }
    return false;
  }

  clearTimeline() {
    this.clearPendingEdit();
    this.clearPendingCommand();
    this.cancelPendingQuestion();
    this.clearPendingContinuation();
    // This sets the status directly, so a pending reset would be redundant at
    // best and would fire over a later status at worst.
    this.clearStatusReset();
    this.follow = true;
    this.state = {
      ...this.state,
      timeline: [],
      activeTurn: null,
      approvalPickerOpen: false,
      status: READY_STATUS,
      isThinking: false,
      pendingEditScrollOffset: 0,
      pendingCommand: null,
      pendingQuestion: null,
      pendingContinuation: null,
      scrollOffset: 0,
      maxScrollOffset: 0,
      maxPendingEditScrollOffset: 0,
      usage: null,
    };
    this.activeAssistantId = null;
    this.emit();
  }

  scrollUp() {
    this.scrollBy(1);
  }

  scrollDown() {
    this.scrollBy(-1);
  }

  scrollBy(lines: number) {
    if (lines === 0) return;

    const scrollOffset = Math.max(
      0,
      Math.min(this.state.scrollOffset + lines, this.state.maxScrollOffset),
    );

    // Reaching the bottom re-arms the follow, leaving it disarms it. Set even
    // when the offset did not move, so pressing ↓ at the bottom of a transcript
    // that has grown while the user was reading puts them back in follow.
    this.follow = scrollOffset === 0;

    if (scrollOffset === this.state.scrollOffset) return;

    this.state = {
      ...this.state,
      scrollOffset,
    };
    this.emit();
  }

  pageUp() {
    this.scrollBy(8);
  }

  pageDown() {
    this.scrollBy(-8);
  }

  scrollToTop() {
    this.follow = false;
    this.state = {
      ...this.state,
      scrollOffset: this.state.maxScrollOffset,
    };
    this.emit();
  }

  /**
   * Records how far the transcript can scroll, and holds the reader's place.
   *
   * This is the only place that learns the content grew, so it is where a view
   * scrolled away from the bottom is kept still: the offset is measured from
   * the last line, so rows landing below would otherwise push what the user is
   * reading off the top by exactly the amount the content grew. Adding that
   * amount back keeps the same lines on screen, without the store needing to
   * know the height of anything it appended.
   */
  setScrollLimit(maxScrollOffset: number) {
    const limit = Math.max(0, maxScrollOffset);
    const previousLimit = this.state.maxScrollOffset;
    const grew = Math.max(0, limit - previousLimit);

    const held = this.follow ? 0 : this.state.scrollOffset + grew;
    const scrollOffset = Math.max(0, Math.min(held, limit));

    if (
      scrollOffset === this.state.scrollOffset &&
      limit === this.state.maxScrollOffset
    ) {
      return;
    }

    this.state = { ...this.state, scrollOffset, maxScrollOffset: limit };
    this.emit();
  }

  /** Back to the latest line, and following it again. */
  scrollToBottom() {
    this.follow = true;

    if (this.state.scrollOffset === 0) return;

    this.state = {
      ...this.state,
      scrollOffset: 0,
    };
    this.emit();
  }

  /** The name `End` and the slash commands already use. */
  resetScroll() {
    this.scrollToBottom();
  }

  /** Whether the transcript is pinned to its latest line. */
  isFollowing() {
    return this.follow;
  }

  scrollPendingEditBy(lines: number) {
    if (lines === 0) return;

    const pendingEditScrollOffset = Math.max(
      0,
      Math.min(
        this.state.pendingEditScrollOffset + lines,
        this.state.maxPendingEditScrollOffset,
      ),
    );

    if (pendingEditScrollOffset === this.state.pendingEditScrollOffset) return;

    this.state = { ...this.state, pendingEditScrollOffset };
    this.emit();
  }

  setPendingEditScrollLimit(maxScrollOffset: number) {
    const limit = Math.max(0, maxScrollOffset);
    const pendingEditScrollOffset = Math.min(
      this.state.pendingEditScrollOffset,
      limit,
    );

    if (
      pendingEditScrollOffset === this.state.pendingEditScrollOffset &&
      limit === this.state.maxPendingEditScrollOffset
    ) {
      return;
    }

    this.state = {
      ...this.state,
      pendingEditScrollOffset,
      maxPendingEditScrollOffset: limit,
    };
    this.emit();
  }

  scrollPendingEditToStart() {
    if (this.state.pendingEditScrollOffset === 0) return;
    this.state = { ...this.state, pendingEditScrollOffset: 0 };
    this.emit();
  }

  scrollPendingEditToEnd() {
    if (
      this.state.pendingEditScrollOffset === this.state.maxPendingEditScrollOffset
    ) {
      return;
    }
    this.state = {
      ...this.state,
      pendingEditScrollOffset: this.state.maxPendingEditScrollOffset,
    };
    this.emit();
  }
}

export const store = new UIStore();
