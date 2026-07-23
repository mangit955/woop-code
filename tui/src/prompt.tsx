import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useRef, useState } from "react";
import type { AgentController } from "../../commands/agentController";

interface PromptProps {
  controller: AgentController;
  onExit: () => Promise<void>;
}

export function Prompt({ controller, onExit }: PromptProps) {
  const [value, setValue] = useState("");
  const [isRunning, setIsRunning] = useState(false);
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

    if (!prompt || isRunning) {
      return;
    }
    if (prompt === "/exit") {
      await onExit();
      return;
    }

    setIsRunning(true);

    try {
      setValue("");
      await controller.run(prompt);
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <Box>
      <Text>❯ </Text>

      <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
    </Box>
  );
}
