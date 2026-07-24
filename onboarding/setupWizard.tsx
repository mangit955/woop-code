import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import chalk from "chalk";
import { getEnabledProviders, type ProviderInfo } from "./providers";
import { loginProvider } from "../config/authProvider";
import { getConfig, saveConfig } from "../config/config";

type WizardStep =
  | "welcome"
  | "select-provider"
  | "api-key-info"
  | "enter-key"
  | "validating"
  | "complete";

interface SetupWizardProps {
  onComplete: () => void;
  onError: (error: string) => void;
}

export function SetupWizard({ onComplete, onError }: SetupWizardProps) {
  const [step, setStep] = useState<WizardStep>("welcome");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedProvider, setSelectedProvider] = useState<ProviderInfo | null>(
    null,
  );
  const [apiKey, setApiKey] = useState("");

  const enabledProviders = getEnabledProviders();

  useInput((input, key) => {
    if (step === "welcome") {
      if (key.return) {
        setStep("select-provider");
      }
    } else if (step === "select-provider") {
      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) =>
          Math.min(enabledProviders.length - 1, prev + 1),
        );
      } else if (key.return) {
        setSelectedProvider(enabledProviders[selectedIndex]!);
        setStep("api-key-info");
      }
    } else if (step === "api-key-info") {
      if (key.return) {
        setStep("enter-key");
      }
    }
  });

  const handleKeySubmit = async (value: string) => {
    if (!selectedProvider || !value.trim()) {
      return;
    }

    setApiKey(value);
    setStep("validating");

    try {
      const isValid = await loginProvider(selectedProvider.id, value.trim());

      if (!isValid) {
        onError("Invalid API key. Please try again.");
        setStep("enter-key");
        setApiKey("");
        return;
      }

      // Save configuration
      const config = await getConfig();
      config.defaultProvider = selectedProvider.id;
      config.providers[selectedProvider.id].apiKey = value.trim();
      await saveConfig(config);

      setStep("complete");
      setTimeout(onComplete, 1000);
    } catch (error) {
      onError(
        error instanceof Error
          ? `Validation failed: ${error.message}`
          : "Network error. Please check your connection and try again.",
      );
      setStep("enter-key");
      setApiKey("");
    }
  };

  if (step === "welcome") {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text bold color="cyan">
          Welcome to Woopcode!
        </Text>
        <Text dimColor> </Text>
        <Text>You'll need an AI provider to use Woopcode.</Text>
        <Text>We'll only ask for this once.</Text>
        <Text dimColor> </Text>
        <Text dimColor>Press Enter to continue...</Text>
      </Box>
    );
  }

  if (step === "select-provider") {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text bold>Select an AI provider:</Text>
        <Text dimColor> </Text>
        {enabledProviders.map((provider, index) => (
          <Box key={provider.id} flexDirection="column">
            <Text color={index === selectedIndex ? "cyan" : undefined}>
              {index === selectedIndex ? "❯ " : "  "}
              {provider.name}
            </Text>
            {index === selectedIndex && (
              <Text dimColor> {provider.description}</Text>
            )}
          </Box>
        ))}
        <Text dimColor> </Text>
        <Text dimColor>Use ↑↓ arrows to select, Enter to confirm</Text>
      </Box>
    );
  }

  if (step === "api-key-info" && selectedProvider) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text bold color="cyan">
          Setting up {selectedProvider.name}
        </Text>
        <Text dimColor> </Text>
        <Text>You can create a free API key at:</Text>
        <Text color="blue" underline>
          {selectedProvider.keyUrl}
        </Text>
        <Text dimColor> </Text>
        <Text dimColor>Press Enter once you have it...</Text>
      </Box>
    );
  }

  if (step === "enter-key" && selectedProvider) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text bold>Paste your {selectedProvider.name} API key:</Text>
        <Text dimColor> </Text>
        <Box>
          <Text dimColor>Key: </Text>
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            onSubmit={handleKeySubmit}
            placeholder="Enter your API key..."
            mask="*"
          />
        </Box>
        <Text dimColor> </Text>
        <Text dimColor>Press Enter to validate</Text>
      </Box>
    );
  }

  if (step === "validating") {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> Validating API key...</Text>
        </Box>
      </Box>
    );
  }

  if (step === "complete") {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="green">✓ API key verified</Text>
        <Text color="green">✓ Configuration saved</Text>
        <Text dimColor> </Text>
        <Text>Starting Woopcode...</Text>
      </Box>
    );
  }

  return null;
}
