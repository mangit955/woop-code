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

export interface PendingEdit {
  id: string;
  filePath: string;
  oldContent: string;
  newContent: string;
  diff: string;
  toolCallId: string;
}

export interface UIState {
  timeline: TimeLineItem[];
  status: string;
  isThinking: boolean;
  pendingEdit: PendingEdit | null;
}

export interface TimelineProps {
  items: TimeLineItem[];
}
export type Listener = () => void;
