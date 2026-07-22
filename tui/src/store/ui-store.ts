import type { Listener, UIState } from "../types";

export class UIStore {
  private state: UIState = { timeline: [], status: "Ready" };
  private listeners: Set<Listener> = new Set();

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
    this.state.timeline.push({
      id: crypto.randomUUID(),
      type: "user",
      content,
    });

    this.emit();
  }

  startAssistantMessage() {
    this.state.timeline.push({
      id: crypto.randomUUID(),
      type: "assistant",
      content: "",
      streaming: true,
    });

    this.emit();
  }

  appendAssistantText(text: string) {
    const last = this.state.timeline.at(-1);
    if (last?.type === "assistant") {
      last.content += text;
    }
    this.emit();
  }

  finishAssistantMessage() {
    const last = this.state.timeline.at(-1);
    if (last?.type === "assistant") {
      last.streaming = false;
    }
    this.emit();
  }

  setStatus(status: string) {
    this.state.status = status;
    this.emit();
  }
}

export const store = new UIStore();
