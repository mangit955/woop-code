import type { Listener, TimeLineItem, UIState } from "../types";
import type { ToolCall } from "../../../config/types";

export class UIStore {
  private state: UIState = { timeline: [], status: "Ready", isThinking: false };
  private listeners: Set<Listener> = new Set();
  private activeAssistantId: string | null = null;
  private pendingEmit = false;

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

  finishTool(id: string) {
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
            }
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

  setStatus(status: string) {
    const isThinking = status.toLowerCase().includes("thinking");
    this.state = { ...this.state, status, isThinking };
    this.emit();
  }
}

export const store = new UIStore();
