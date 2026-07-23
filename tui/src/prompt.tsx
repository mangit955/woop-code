import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";
import type { AgentController } from "../../commands/agentController";

interface PromptProps {
  controller: AgentController;
}

export function Prompt({ controller }: PromptProps) {
  const [value, setValue] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  async function handleSubmit(input: string) {
    const prompt = input.trim();

    if (!prompt || isRunning) {
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
