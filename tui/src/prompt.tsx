import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useRef } from "react";
import type { AgentController } from "../../commands/agentController";
import { handleSlashCommand } from "../../commands/slash";
import { store } from "./store/ui-store";

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

    // 🔥 Slash command interception
    const context = {
      controller,
      onExit,
      onOutput: (message: string) => {
        store.addSystemMessage(message);
      },
    };

    const result = await handleSlashCommand(prompt, context);

    if (result.handled) {
      onValueChange("");
      return;
    }

    // Original flow
    if (prompt === "/exit") {
      await onExit();
      return;
    }

    onValueChange("");
    
    // Run the agent with error handling to keep app alive
    try {
      await controller.run(prompt);
    } catch (error) {
      // Error already displayed via callbacks.onError
      // Just catch it here to prevent app crash
      if (process.env.DEBUG) {
        console.error("Prompt handler caught error:", error);
      }
    }
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
