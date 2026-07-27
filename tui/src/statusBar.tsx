import { Box, Text } from "ink";
import { useUIStore } from "./store/useUIStore";
import { colors } from "./styles/theme";
import { StatusSpinner } from "./components/StatusSpinner";

const workspacePath = process.cwd().replace(process.env.HOME ?? "", "~");

// ─── Pure presentational component ───────────────────────────────────────────

type StatusState = "ready" | "thinking" | "tool" | "error" | "cancelled";

interface StatusBarProps {
  status: StatusState;
  message?: string;
}

export function StatusBar({ status, message }: StatusBarProps) {
  return (
    <Box justifyContent="space-between" width="100%">
      <Box gap={1}>
        <StatusIcon status={status} />
        <StatusLabel status={status} message={message} />
      </Box>
      <Box gap={2} flexShrink={0}>
        <Text color={colors.textFaint}>↑↓ scroll</Text>
        <Text color={colors.textFaint}>ctrl+c</Text>
      </Box>
    </Box>
  );
}

function StatusIcon({ status }: { status: StatusState }) {
  if (status === "thinking" || status === "tool") {
    return <StatusSpinner />;
  }
  if (status === "ready") return <Text color="green">●</Text>;
  if (status === "error") return <Text color={colors.dangerBase}>●</Text>;
  // cancelled
  return <Text color={colors.textMuted}>●</Text>;
}

function StatusLabel({
  status,
  message,
}: {
  status: StatusState;
  message?: string;
}) {
  if (status === "ready") {
    return <Text color={colors.textMuted}>{workspacePath}</Text>;
  }
  if (status === "error")
    return <Text color={colors.dangerBase}>{message ?? "Error"}</Text>;
  if (status === "cancelled")
    return <Text color={colors.textMuted}>{message ?? "Cancelled"}</Text>;
  // thinking or tool — animated, show message
  return <Text color={colors.textMuted}>{message}</Text>;
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

  if (lower.startsWith("working") || lower.startsWith("running ")) {
    return { state: "tool", message: "Working…" };
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
