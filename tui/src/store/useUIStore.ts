import { useEffect, useState } from "react";
import { store } from "./ui-store";

export function useUIStore() {
  const [state, setState] = useState(store.getState());

  useEffect(() => {
    return store.subscribe(() => {
      setState({ ...store.getState() });
    });
  }, []);
  return state;
}
