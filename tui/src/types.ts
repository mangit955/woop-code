import type { ApprovalMode, CommandRisk } from "../../runtime/approval";
import type { SessionMode } from "../../runtime/planMode";
import type { TodoItem } from "../../config/types";

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
      /**
       * `blocked` is a refusal by policy — plan mode declining a write. It is
       * kept apart from `failed` because the tool never ran and nothing is
       * wrong, so it must not be drawn like a fault.
       */
      status: "running" | "completed" | "failed" | "blocked";
      /** Short report of what came back, e.g. "8 matches". */
      summary?: string;
      /** Command output, kept for tools rendered as a shell block. */
      output?: string;
    }
  | {
      id: string;
      type: "todo";
      items: TodoItem[];
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
  toolName: "run_terminal" | "run_tests" | "repl" | "process_start";
  /** Why it needs approval, from the classifier. */
  risk?: CommandRisk;
}

export interface PendingQuestion {
  id: string;
  questions: string[];
}

/** A turn that has spent its step budget and is asking whether to keep going. */
export interface PendingContinuation {
  id: string;
  /** Steps taken so far, which is what the user is being asked to extend. */
  steps: number;
}

export interface UIState {
  timeline: TimeLineItem[];
  activeTurn: ActiveTurn | null;
  approvalMode: ApprovalMode;
  approvalPickerOpen: boolean;
  /**
   * Build or Plan, mirrored from the controller so components can subscribe.
   * The controller stays authoritative — the same split `selectedModel` uses.
   */
  sessionMode: SessionMode;
  status: string;
  isThinking: boolean;
  modelPickerOpen: boolean;
  sessionPickerOpen: boolean;
  selectedModel: string | null;
  pendingEdit: PendingEdit | null;
  pendingCommand: PendingCommand | null;
  pendingQuestion: PendingQuestion | null;
  pendingContinuation: PendingContinuation | null;
  pendingEditScrollOffset: number;
  scrollOffset: number;
  /**
   * How far each viewport *can* be scrolled, measured from its rendered
   * content. In the state rather than private to the store because the
   * scrollbar is drawn from the pair: an offset alone cannot say how much is
   * left below it.
   */
  maxScrollOffset: number;
  maxPendingEditScrollOffset: number;
  /** Prompt tokens the last provider request carried; null before the first. */
  usage: { promptTokens: number } | null;
}

export interface TimelineProps {
  items: TimeLineItem[];
}
export type Listener = () => void;
