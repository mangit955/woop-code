import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { usePalette } from "../styles/palette";

interface ToolStatusProps {
  status: "running" | "completed" | "failed" | "blocked";
  /** The glyph for this kind of tool, shown once the call has settled. */
  glyph: string;
}

export function ToolStatus({ status, glyph }: ToolStatusProps) {
  const colors = usePalette();

  if (status === "running") {
    return (
      <Text color={colors.primary}>
        <Spinner type="dots" />
      </Text>
    );
  }

  // A completed call is a record, not an outcome to celebrate: the glyph says
  // what kind of work it was and stays out of the way. Only failure stands out.
  if (status === "completed") {
    return <Text color={colors.textFaint}>{glyph}</Text>;
  }

  // Refused by policy, not broken. A slash reads as "did not happen" where a
  // cross reads as "went wrong", and it stays muted so a plan-mode session is
  // not a column of red for behaving exactly as asked.
  if (status === "blocked") {
    return <Text color={colors.textFaint}>⊘</Text>;
  }

  if (status === "failed") {
    return <Text color={colors.dangerBase}>✗</Text>;
  }

  return null;
}
