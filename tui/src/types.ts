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
      /** Short report of what came back, e.g. "8 matches". */
      summary?: string;
    }
  | ({
      id: string;
      type: "turn";
      /** Wall-clock end of the turn, so the elapsed time freezes in history. */
      endedAt: number;
      outcome: TurnOutcome;
    } & TurnIdentity);

export type TurnOutcome = "completed" | "cancelled" | "error";

/** The parts of a turn footer that are known the moment the turn starts. */
export interface TurnIdentity {
  /** Agent mode label, e.g. "Build". */
  agent: string;
  /** Raw model id; the footer resolves it to a display name when rendering. */
  model: string;
  startedAt: number;
}

/**
 * The turn currently in flight. Held outside the timeline so its footer always
 * renders after the last item, which is what makes it travel down the
 * transcript as tool rows and assistant text arrive.
 */
export interface ActiveTurn extends TurnIdentity {
  id: string;
}

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

export interface PendingQuestion {
  id: string;
  questions: string[];
}

export interface UIState {
  timeline: TimeLineItem[];
  activeTurn: ActiveTurn | null;
  status: string;
  isThinking: boolean;
  modelPickerOpen: boolean;
  selectedModel: string | null;
  pendingEdit: PendingEdit | null;
  pendingCommand: PendingCommand | null;
  pendingQuestion: PendingQuestion | null;
  pendingEditScrollOffset: number;
  scrollOffset: number;
}

export interface TimelineProps {
  items: TimeLineItem[];
}
export type Listener = () => void;
