import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useBootAnimation, STEPS } from "../hooks/useBootAnimation";
import { LogoReveal } from "./LogoReveal";
import { colors } from "../styles/theme";

interface BootScreenProps {
  onComplete: () => void;
}

export function BootScreen({ onComplete }: BootScreenProps) {
  const { logoText, loadingStep, doneSteps, phase } = useBootAnimation(onComplete);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Logo with premium animated reveal */}
      <Box marginBottom={1}>
        {phase === "logo" ? (
          <LogoReveal
            text="Woopcode"
            duration={400}
            mode="highlight"
            highlightColor={colors.primary}
            onComplete={() => {}}
          />
        ) : (
          <Text bold color={colors.primary}>
            Woopcode
          </Text>
        )}
      </Box>

      {/* Steps — only visible once logo is done */}
      {phase !== "logo" && (
        <Box flexDirection="column" marginBottom={1}>
          {STEPS.map((label, i) => (
            <StepRow
              key={label}
              label={label}
              done={doneSteps.has(i)}
              loading={loadingStep === i}
            />
          ))}
        </Box>
      )}

      {/* Launching line */}
      {(phase === "launching" || phase === "done") && (
        <Box marginTop={1}>
          <Text dimColor>Launching Woopcode…</Text>
        </Box>
      )}
    </Box>
  );
}

interface StepRowProps {
  label: string;
  done: boolean;
  loading: boolean;
}

function StepRow({ label, done, loading }: StepRowProps) {
  return (
    <Box gap={1}>
      <StepIcon done={done} loading={loading} />
      <Text color={done ? colors.successBase : loading ? colors.primary : colors.textMuted}>
        {label}
      </Text>
    </Box>
  );
}

function StepIcon({ done, loading }: { done: boolean; loading: boolean }) {
  if (done)    return <Text color={colors.successBase}>✓</Text>;
  if (loading) return <Text color={colors.primary}><Spinner type="dots" /></Text>;
  return       <Text color={colors.textMuted}>○</Text>;
}
