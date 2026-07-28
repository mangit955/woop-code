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
      type: "system";
      content: string;
    }
  | {
      id: string;
      type: "tool";
      name: string;
      arguments: Record<string, unknown>;
      status: "running" | "completed" | "failed";
    };

export interface PendingEdit {
  id: string;
  filePath: string;
  oldContent: string;
  newContent: string;
  diff: string;
  toolCallId: string;
}

export interface PendingCommand {
  id: string;
  command: string;
  toolName: "run_terminal" | "run_tests";
}

export interface UIState {
  timeline: TimeLineItem[];
  status: string;
  isThinking: boolean;
  modelPickerOpen: boolean;
  selectedModel: string | null;
  pendingEdit: PendingEdit | null;
  pendingCommand: PendingCommand | null;
  pendingEditScrollOffset: number;
  scrollOffset: number;
}

export interface TimelineProps {
  items: TimeLineItem[];
}
export type Listener = () => void;
