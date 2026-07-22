import { Text } from "ink";
import { useUIStore } from "./store/useUIStore";

export function StatusBar() {
  const { status } = useUIStore();

  return <Text color="green">{status}</Text>;
}
