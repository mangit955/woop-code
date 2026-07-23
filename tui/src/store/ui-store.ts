import type { Listener, TimeLineItem, UIState } from "../types";
import type { ToolCall } from "../../../config/types";

export class UIStore {
  private state: UIState = { timeline: [], status: "Ready" };
  private listeners: Set<Listener> = new Set();
  private activeAssistantId: string | null = null;

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
    this.state = {
      ...this.state,
      timeline: this.state.timeline.map((item) =>
        item.type === "assistant" && item.id === this.activeAssistantId
          ? {
              ...item,
              content: item.content + text,
            }
          : item,
      ),
    };

    this.emit();
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
    this.state = {
      ...this.state,
      status,
    };

    this.emit();
  }
}

export const store = new UIStore();
