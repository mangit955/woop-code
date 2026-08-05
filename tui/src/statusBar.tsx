import { Box, Text } from "ink";
import { useUIStore } from "./store/useUIStore";
import { usePalette } from "./styles/palette";
import { StatusSpinner } from "./components/StatusSpinner";
import { useTerminalSize } from "./hooks/useTerminalSize";
import { planLayout, truncateStart } from "./layout";
import { sessionModeColor } from "../../runtime/planMode";
import { findModel, formatContextWindow } from "../../providers/modelCatalog";

const workspacePath = process.cwd().replace(process.env.HOME ?? "", "~");

// ─── Pure presentational component ───────────────────────────────────────────

type StatusState = "ready" | "thinking" | "tool" | "error" | "cancelled";

interface StatusBarProps {
  status: StatusState;
  message?: string;
  /** Hidden in narrow terminals, where they used to collide with the label. */
  showKeyHints?: boolean;
  /** Columns the label may use before it has to give way to the hints. */
  labelWidth?: number;
  /** Plan mode: the Tab hint points the other way and turns amber. */
  planning?: boolean;
  /** Prompt size against the model's window, e.g. "48k/1M · 5%". Empty until measured. */
  context?: string;
}

export function StatusBar({
  status,
  message,
  showKeyHints = true,
  labelWidth,
  planning = false,
  context,
}: StatusBarProps) {
  const colors = usePalette();

  return (
    <Box justifyContent="space-between" width="100%">
      <Box gap={1} flexShrink={1} minWidth={0}>
        <StatusIcon status={status} />
        <StatusLabel status={status} message={message} labelWidth={labelWidth} />
      </Box>
      <Box gap={2} flexShrink={0}>
        {context && (
          <Text color={colors.textFaint}>{context}</Text>
        )}
        {showKeyHints && (
          <>
            {/* Named after what the key leads to, not the state it leaves: "tab
                plan" while building, "tab build" while planning. Amber only while
                planning — in Build this is one hint among three and should not
                outrank them. */}
            <Text color={planning ? sessionModeColor("plan", colors) : colors.textFaint}>
              tab {planning ? "build" : "plan"}
            </Text>
            <Text color={colors.textFaint}>↑↓ history</Text>
            <Text color={colors.textFaint}>ctrl+c</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

function StatusIcon({ status }: { status: StatusState }) {
  const colors = usePalette();

  if (status === "thinking" || status === "tool") {
    return <StatusSpinner />;
  }
  if (status === "ready") return <Text color={colors.successBase}>●</Text>;
  if (status === "error") return <Text color={colors.dangerBase}>●</Text>;
  // cancelled
  return <Text color={colors.textMuted}>●</Text>;
}

function StatusLabel({
  status,
  message,
  labelWidth,
}: {
  status: StatusState;
  message?: string;
  labelWidth?: number;
}) {
  const colors = usePalette();

  if (status === "ready") {
    // The last segment is the useful part of a path, so trim from the front.
    return (
      <Text color={colors.textMuted} wrap="truncate-end">
        {labelWidth ? truncateStart(workspacePath, labelWidth) : workspacePath}
      </Text>
    );
  }
  if (status === "error")
    return (
      <Text color={colors.dangerBase} wrap="truncate-end">
        {message ?? "Error"}
      </Text>
    );
  if (status === "cancelled")
    return (
      <Text color={colors.textMuted} wrap="truncate-end">
        {message ?? "Cancelled"}
      </Text>
    );
  // thinking or tool — animated, show message
  return (
    <Text color={colors.textMuted} wrap="truncate-end">
      {message}
    </Text>
  );
}

// ─── Connected wrapper (reads from store) ────────────────────────────────────

/**
 * Columns the spinner, gaps, and "tab plan  ↑↓ scroll  ctrl+c" hints occupy.
 *
 * Grew by ten when the Tab hint was added — eight for the widest of "tab build"
 * and "tab plan", two for its gap. Left short, the workspace path would run into
 * the hints on a narrow terminal instead of being truncated before them.
 */
const HINTS_AND_ICON_COLUMNS = 39;

/** Columns "48k/1M · 5%" and its gap need before the path has to give way. */
const CONTEXT_METER_COLUMNS = 16;

/**
 * The prompt against the window it has to fit in.
 *
 * The percentage is the point rather than the raw count: 48k means nothing
 * without knowing whether the model holds 200k or a million, and the number a
 * user acts on — clear the conversation, or carry on — is the fraction.
 *
 * Exported for its own test. It reads a model that may not be in the catalog,
 * which is the case it has to get right: an unknown model has no window, and
 * inventing one would put a confident percentage on a guess.
 */
export function formatContextMeter(
  promptTokens: number,
  modelId: string | null,
): string | undefined {
  const contextWindow = modelId ? findModel(modelId)?.contextWindow : undefined;
  if (!contextWindow) return undefined;

  const percent = Math.min(100, Math.round((promptTokens / contextWindow) * 100));

  return `${formatContextWindow(promptTokens)}/${formatContextWindow(contextWindow)} · ${percent}%`;
}

export function ConnectedStatusBar() {
  const { status, sessionMode, usage, selectedModel } = useUIStore();
  const { width, height } = useTerminalSize();
  const layout = planLayout(width, height);
  const { state, message } = parseStatus(status);

  const context =
    usage && layout.showContextMeter
      ? formatContextMeter(usage.promptTokens, selectedModel)
      : undefined;

  return (
    <StatusBar
      status={state}
      message={message}
      planning={sessionMode === "plan"}
      showKeyHints={layout.showKeyHints}
      context={context}
      labelWidth={Math.max(
        1,
        width -
          (layout.showKeyHints ? HINTS_AND_ICON_COLUMNS : 12) -
          (context ? CONTEXT_METER_COLUMNS : 0),
      )}
    />
  );
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
