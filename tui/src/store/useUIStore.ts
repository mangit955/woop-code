import { useSyncExternalStore } from "react";
import { store } from "./ui-store";

export function useUIStore() {
  return useSyncExternalStore(
    store.subscribe.bind(store),
    store.getState.bind(store),
  );
}
