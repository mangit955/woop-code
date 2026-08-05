import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";
import type { PendingQuestion } from "../types";
import { store } from "../store/ui-store";
import { usePalette } from "../styles/palette";
import { planLayout } from "../layout";
import { useTerminalSize } from "../hooks/useTerminalSize";

export function QuestionDialog({ question }: { question: PendingQuestion }) {
  const colors = usePalette();
  const { width, height } = useTerminalSize();
  const layout = planLayout(width, height);
  const [index, setIndex] = useState(0);
  const [value, setValue] = useState("");
  const [answers, setAnswers] = useState<string[]>([]);
  const currentQuestion = question.questions[index];

  useInput((_, key) => {
    if (key.escape) store.cancelPendingQuestion();
  });

  const submit = (answer: string) => {
    const nextAnswers = [...answers, answer];
    if (index === question.questions.length - 1) {
      store.answerPendingQuestion(nextAnswers);
      return;
    }
    setAnswers(nextAnswers);
    setValue("");
    setIndex((current) => current + 1);
  };

  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
      {/* Opaque, so the transcript behind the dialog does not show through. */}
      <Box
        flexDirection="column"
        width="80%"
        borderStyle={layout.showDialogBorder ? "round" : undefined}
        borderColor={colors.borderElevated}
        backgroundColor={colors.bgElevated}
        paddingX={1}
      >
        <Text bold color={colors.primary}>Question {index + 1} of {question.questions.length}</Text>
        <Box marginTop={1}><Text color={colors.textBase}>{currentQuestion}</Text></Box>
        <Box marginTop={1}>
          <Text color={colors.textMuted}>Answer: </Text>
          <TextInput value={value} onChange={setValue} onSubmit={submit} />
        </Box>
        <Box marginTop={1}>
          <Text color={colors.textMuted}><Text color={colors.dangerBase}>Esc</Text> cancel · <Text color={colors.successBase}>Enter</Text> next</Text>
        </Box>
      </Box>
    </Box>
  );
}
