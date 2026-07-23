import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useUIStore } from "./store/useUIStore";

// ─── Pure presentational component ───────────────────────────────────────────

type StatusState = "ready" | "thinking" | "tool" | "error" | "cancelled";

interface StatusBarProps {
  status: StatusState;
  message?: string;
}

export function StatusBar({ status, message }: StatusBarProps) {
  return (
    <Box gap={1}>
      <StatusIcon status={status} />
      <StatusLabel status={status} message={message} />
    </Box>
  );
}

function StatusIcon({ status }: { status: StatusState }) {
  if (status === "thinking" || status === "tool") {
    return (
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
    );
  }
  if (status === "ready") return <Text color="green">✓</Text>;
  if (status === "error") return <Text color="red">✗</Text>;
  // cancelled
  return <Text dimColor>–</Text>;
}

function StatusLabel({
  status,
  message,
}: {
  status: StatusState;
  message?: string;
}) {
  if (status === "ready") return <Text dimColor>Ready</Text>;
  if (status === "error")
    return <Text color="red">{message ?? "Error"}</Text>;
  if (status === "cancelled")
    return <Text dimColor>{message ?? "Cancelled"}</Text>;
  // thinking or tool — animated, show message
  return <Text color="cyan">{message}</Text>;
}

// ─── Connected wrapper (reads from store) ────────────────────────────────────

export function ConnectedStatusBar() {
  const { status } = useUIStore();
  const { state, message } = parseStatus(status);
  return <StatusBar status={state} message={message} />;
}

function parseStatus(raw: string): { state: StatusState; message?: string } {
  const lower = raw.toLowerCase();

  if (lower.includes("thinking")) {
    return { state: "thinking", message: "Thinking…" };
  }

  if (lower.startsWith("running ")) {
    // "Running read_file..." → message = "Running read_file"
    return { state: "tool", message: raw.replace(/\.*$/, "") };
  }

  if (lower.startsWith("error")) {
    const msg = raw.replace(/^error[:\s]*/i, "").trim();
    return { state: "error", message: msg || "Something went wrong" };
  }

  if (lower.includes("cancelled")) {
    return { state: "cancelled" };
  }

  return { state: "ready" };
}
