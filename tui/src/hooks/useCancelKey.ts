import { useInput } from "ink";
import { useRef } from "react";
import type { AgentController } from "../../../commands/agentController";
import { store } from "../store/ui-store";
import { resolveCancelKey } from "../keys";

interface UseCancelKeyOptions {
  controller: AgentController;
  onExit: () => Promise<void>;
}

/**
 * Owns Ctrl+C for the whole app.
 *
 * This has to live on a component that never unmounts. Registering it inside
 * the composer meant every modal took the cancel key down with it, so a turn
 * parked on an approval could not be stopped at all. Ink delivers input to
 * every mounted handler, so this is also the single owner: no other component
 * may claim Ctrl+C, or one press would be handled twice.
 */
export function useCancelKey({ controller, onExit }: UseCancelKeyOptions) {
  const isExiting = useRef(false);

  useInput(
    (input, key) => {
      if (!(key.ctrl && input.toLowerCase() === "c")) return;

      const action = resolveCancelKey({
        busy: controller.isBusy(),
        modal: store.hasOpenModal(),
      });

      if (action === "cancel-request") {
        // Resolves any modal the turn was waiting on as part of aborting it.
        controller.cancel();
        return;
      }

      if (action === "dismiss-modal") {
        store.dismissTopModal();
        return;
      }

      if (!isExiting.current) {
        isExiting.current = true;
        void onExit();
      }
    },
    { isActive: true },
  );
}
