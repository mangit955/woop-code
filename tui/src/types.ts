export type TimeLineItem =
  | {
      id: string;
      type: "user";
      content: string;
    }
  | {
      id: string;
      type: "assistant";
      content: string;
      streaming: boolean;
    }
  | {
      id: string;
      type: "tool";
      name: string;
      arguments: Record<string, unknown>;
      status: "running" | "completed";
    };

export interface UIState {
  timeline: TimeLineItem[];
  status: string;
  isThinking: boolean;
}

export interface TimelineProps {
  items: TimeLineItem[];
}
export type Listener = () => void;
