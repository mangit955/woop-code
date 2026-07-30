import type { Listener, PendingCommand, PendingEdit, PendingQuestion, TimeLineItem, TurnIdentity, TurnOutcome, UIState } from "../types";
import type { ToolCall } from "../../../config/types";

/** The idle status, and what a transient status reverts to. */
export const READY_STATUS = "Ready";

export class UIStore {
  private state: UIState = {
    timeline: [],
    activeTurn: null,
    status: READY_STATUS,
    isThinking: false,
    modelPickerOpen: false,
    selectedModel: null,
    pendingEdit: null,
    pendingCommand: null,
    pendingQuestion: null,
    pendingEditScrollOffset: 0,
    scrollOffset: 0,
  };
  private listeners: Set<Listener> = new Set();
  private activeAssistantId: string | null = null;
  private pendingEmit = false;
  private maxScrollOffset = 0;
  private maxPendingEditScrollOffset = 0;
  private editResolvers: Map<
    string,
    { resolve: (approved: boolean) => void; reject: (error: Error) => void }
  > = new Map();
  private commandResolvers: Map<string, { resolve: (approved: boolean) => void }> = new Map();
  private questionResolvers: Map<string, { resolve: (answers: string[] | null) => void }> = new Map();
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
    this.state = {
      ...this.state,
      scrollOffset: 0, // Reset scroll on new message
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
    };

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
      scrollOffset: 0, // Reset scroll
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

  finishTool(id: string, summary?: string) {
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
              summary,
            }
          : item,
      ),
    };

    this.emit();
  }

  failTool(id: string) {
    this.state = {
      ...this.state,
      timeline: this.state.timeline.map((item) =>
        item.type === "tool" && item.id === id
          ? { ...item, status: "failed" }
          : item,
      ),
    };
    this.emit();
  }

  startAssistantMessage() {
    const id = crypto.randomUUID();
    this.activeAssistantId = id;

    this.state = {
      ...this.state,
      scrollOffset: 0, // Reset scroll
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

  // Pending Edit Management
  setPendingEdit(edit: PendingEdit): Promise<boolean> {
    if (this.nonInteractive) {
      return Promise.resolve(this.nonInteractiveApproval);
    }

    this.maxPendingEditScrollOffset = 0;
    this.state = {
      ...this.state,
      pendingEdit: edit,
      pendingEditScrollOffset: 0,
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

  /** True when a modal owns the screen, so global keys can tell. */
  hasOpenModal() {
    const { modelPickerOpen, pendingCommand, pendingQuestion, pendingEdit } = this.state;
    return modelPickerOpen || pendingCommand !== null || pendingQuestion !== null || pendingEdit !== null;
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
    if (this.state.pendingCommand) {
      this.rejectPendingCommand();
      return true;
    }
    if (this.state.pendingQuestion) {
      this.cancelPendingQuestion();
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
    // This sets the status directly, so a pending reset would be redundant at
    // best and would fire over a later status at worst.
    this.clearStatusReset();
    this.maxScrollOffset = 0;
    this.maxPendingEditScrollOffset = 0;
    this.state = {
      ...this.state,
      timeline: [],
      activeTurn: null,
      status: READY_STATUS,
      isThinking: false,
      pendingEditScrollOffset: 0,
      pendingCommand: null,
      pendingQuestion: null,
      scrollOffset: 0,
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
      Math.min(this.state.scrollOffset + lines, this.maxScrollOffset),
    );

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
    this.state = {
      ...this.state,
      scrollOffset: this.maxScrollOffset,
    };
    this.emit();
  }

  setScrollLimit(maxScrollOffset: number) {
    this.maxScrollOffset = Math.max(0, maxScrollOffset);
    const scrollOffset = Math.min(this.state.scrollOffset, this.maxScrollOffset);

    if (scrollOffset === this.state.scrollOffset) return;

    this.state = { ...this.state, scrollOffset };
    this.emit();
  }

  resetScroll() {
    this.state = {
      ...this.state,
      scrollOffset: 0,
    };
    this.emit();
  }

  scrollPendingEditBy(lines: number) {
    if (lines === 0) return;

    const pendingEditScrollOffset = Math.max(
      0,
      Math.min(
        this.state.pendingEditScrollOffset + lines,
        this.maxPendingEditScrollOffset,
      ),
    );

    if (pendingEditScrollOffset === this.state.pendingEditScrollOffset) return;

    this.state = { ...this.state, pendingEditScrollOffset };
    this.emit();
  }

  setPendingEditScrollLimit(maxScrollOffset: number) {
    this.maxPendingEditScrollOffset = Math.max(0, maxScrollOffset);
    const pendingEditScrollOffset = Math.min(
      this.state.pendingEditScrollOffset,
      this.maxPendingEditScrollOffset,
    );

    if (pendingEditScrollOffset === this.state.pendingEditScrollOffset) return;

    this.state = { ...this.state, pendingEditScrollOffset };
    this.emit();
  }

  scrollPendingEditToStart() {
    if (this.state.pendingEditScrollOffset === 0) return;
    this.state = { ...this.state, pendingEditScrollOffset: 0 };
    this.emit();
  }

  scrollPendingEditToEnd() {
    if (this.state.pendingEditScrollOffset === this.maxPendingEditScrollOffset) return;
    this.state = {
      ...this.state,
      pendingEditScrollOffset: this.maxPendingEditScrollOffset,
    };
    this.emit();
  }
}

export const store = new UIStore();
