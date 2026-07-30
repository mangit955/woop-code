/**
 * What Ctrl+C means depends on what the session is doing, and it has to mean
 * something everywhere. It used to be registered only inside the composer, so
 * every modal — edit approval, command approval, questions, model selection —
 * unmounted the one handler that understood it and left Esc as the only key.
 * Esc rejects the modal, which is not the same as stopping the agent.
 */
export type CancelAction = "cancel-request" | "dismiss-modal" | "exit";

export interface CancelContext {
  /** A turn is in flight, including one parked on a modal awaiting approval. */
  busy: boolean;
  /** A modal owns the screen. */
  modal: boolean;
}

/**
 * Stopping the running agent outranks closing the window that is waiting on it:
 * a modal open mid-turn is the agent asking a question, so cancelling the turn
 * is what the user means. Cancelling tears the modal down on its way out.
 *
 * With nothing running, a modal is just a window, so Ctrl+C closes it and a
 * second press exits — quitting the whole session on the first press would be a
 * surprising amount of destruction for one keystroke.
 */
export function resolveCancelKey({ busy, modal }: CancelContext): CancelAction {
  if (busy) return "cancel-request";
  if (modal) return "dismiss-modal";
  return "exit";
}
