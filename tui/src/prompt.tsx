import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useRef } from "react";
import type { AgentController } from "../../commands/agentController";

interface PromptProps {
  controller: AgentController;
  onExit: () => Promise<void>;
  value: string;
  placeholder?: string;
  onValueChange: (value: string) => void;
}

export function Prompt({
  controller,
  onExit,
  value,
  placeholder,
  onValueChange,
}: PromptProps) {
  const isExiting = useRef(false);

  useInput((input, key) => {
    if (!(key.ctrl && input.toLowerCase() === "c")) {
      return;
    }

    if (controller.isBusy()) {
      controller.cancel();
      return;
    }

    if (!isExiting.current) {
      isExiting.current = true;
      void onExit();
    }
  });

  async function handleSubmit(input: string) {
    const prompt = input.trim();

    if (!prompt || controller.isBusy()) {
      return;
    }
    if (prompt === "/exit") {
      await onExit();
      return;
    }

    onValueChange("");
    await controller.run(prompt);
  }

  return (
    <Box>
      <Text color="cyan">❯ </Text>

      <TextInput
        value={value}
        placeholder={placeholder}
        showCursor
        onChange={onValueChange}
        onSubmit={handleSubmit}
      />
    </Box>
  );
}
