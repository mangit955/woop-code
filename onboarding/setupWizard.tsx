import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { getEnabledProviders, type ProviderInfo } from "../providers/providerRegistry";
import { loginProvider } from "../config/authProvider";
import { apiProviderEntry, getConfig, saveConfig } from "../config/config";
import {
  DEMO_PROVIDER,
  demoProviderEntry,
  requestDemoSession,
} from "../config/demoAccount";
import { colors } from "../tui/src/styles/theme";

type WizardStep =
  | "welcome"
  | "choose-path"
  | "demo-disclosure"
  | "requesting-demo"
  | "select-provider"
  | "api-key-info"
  | "enter-key"
  | "validating"
  | "complete";

/** The two ways out of the welcome screen, in the order they are listed. */
const PATHS = ["demo", "own-key"] as const;
type SetupPath = (typeof PATHS)[number];

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
  const [pathIndex, setPathIndex] = useState(0);
  /**
   * Which path reached the final screen. Not derived from `pathIndex`: a demo
   * request that fails falls back to provider selection while leaving the
   * highlight where it was, so the index says "demo" for a run that ended with
   * the user pasting their own key.
   */
  const [completedVia, setCompletedVia] = useState<SetupPath>("own-key");

  const enabledProviders = getEnabledProviders();

  useInput((input, key) => {
    if (step === "welcome") {
      if (key.return) {
        setStep("choose-path");
      }
    } else if (step === "choose-path") {
      if (key.upArrow) {
        setPathIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setPathIndex((prev) => Math.min(PATHS.length - 1, prev + 1));
      } else if (key.return) {
        setStep(PATHS[pathIndex]! === "demo" ? "demo-disclosure" : "select-provider");
      }
    } else if (step === "demo-disclosure") {
      // Two distinct keys, not "any key". The disclosure below is the only
      // notice a demo user gets that their code reaches Google's free tier,
      // and a screen dismissed by whatever they happened to press next is not
      // a notice anyone read.
      if (input === "y" || input === "Y") {
        void startDemo();
      } else if (key.escape || input === "n" || input === "N") {
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

  const startDemo = async () => {
    setStep("requesting-demo");

    try {
      const session = await requestDemoSession();

      const config = await getConfig();
      config.defaultProvider = DEMO_PROVIDER;
      config.providers[DEMO_PROVIDER] = demoProviderEntry(session);
      await saveConfig(config);

      setCompletedVia("demo");
      setStep("complete");
      setTimeout(onComplete, 1000);
    } catch (error) {
      // The demo is the optional path. When it is unavailable the wizard drops
      // into provider selection rather than dead-ending, so a user who came to
      // set up their own key is not blocked by a service they never wanted.
      onError(
        error instanceof Error
          ? error.message
          : "Could not start the demo. You can still set up your own API key.",
      );
      setStep("select-provider");
    }
  };

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

      const config = await getConfig();
      config.defaultProvider = selectedProvider.id;
      // Built fresh, which covers both a provider with no entry yet and one
      // holding a demo entry whose proxy URL must not survive a real key.
      config.providers[selectedProvider.id] = apiProviderEntry(value.trim());
      await saveConfig(config);

      setCompletedVia("own-key");
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
        <Text bold color={colors.primary}>
          Welcome to Woopcode!
        </Text>
        <Text dimColor> </Text>
        <Text>Let's get you set up. We'll only ask for this once.</Text>
        <Text dimColor> </Text>
        <Text dimColor>Press Enter to continue...</Text>
      </Box>
    );
  }

  if (step === "choose-path") {
    const options = [
      {
        label: "Try the demo — no API key needed",
        hint: "Runs on Gemini through Woopcode's demo service. Limited daily usage.",
      },
      {
        label: "Use my own API key",
        hint: "Google, OpenAI or Anthropic. Your key stays on this machine.",
      },
    ];

    return (
      <Box flexDirection="column" paddingY={1}>
        <Text bold>How would you like to start?</Text>
        <Text dimColor> </Text>
        {options.map((option, index) => (
          <Box key={option.label} flexDirection="column">
            <Text color={index === pathIndex ? colors.primary : undefined}>
              {index === pathIndex ? "❯ " : "  "}
              {option.label}
            </Text>
            {index === pathIndex && <Text dimColor> {option.hint}</Text>}
          </Box>
        ))}
        <Text dimColor> </Text>
        <Text dimColor>Use ↑↓ arrows to select, Enter to confirm</Text>
      </Box>
    );
  }

  if (step === "demo-disclosure") {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text bold color={colors.primary}>
          Before you try the demo
        </Text>
        <Text dimColor> </Text>
        <Text>
          The demo runs on Google's free tier. Under Google's terms, anything
          you send there — including the contents of files in this repository —
          may be used to improve Google's models, and may be read by human
          reviewers.
        </Text>
        <Text dimColor> </Text>
        <Text bold>Don't use the demo on private or confidential code.</Text>
        <Text dimColor> </Text>
        <Text dimColor>
          Using your own API key avoids this. You can switch any time with
          /login.
        </Text>
        <Text dimColor> </Text>
        <Text>
          Press <Text bold>y</Text> to accept and start the demo, or{" "}
          <Text bold>n</Text> to set up your own key.
        </Text>
      </Box>
    );
  }

  if (step === "requesting-demo") {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box>
          <Text color={colors.primary}>
            <Spinner type="dots" />
          </Text>
          <Text> Starting your demo session...</Text>
        </Box>
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
            <Text color={index === selectedIndex ? colors.primary : undefined}>
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
        <Text bold color={colors.primary}>
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
          <Text color={colors.primary}>
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
        {completedVia === "demo" ? (
          <>
            <Text color="green">✓ Demo session started</Text>
            <Text dimColor>
              Limited daily usage. Run /login to switch to your own API key.
            </Text>
          </>
        ) : (
          <>
            <Text color="green">✓ API key verified</Text>
            <Text color="green">✓ Configuration saved</Text>
          </>
        )}
        <Text dimColor> </Text>
        <Text>Starting Woopcode...</Text>
      </Box>
    );
  }

  return null;
}
