import { Box, Text, useStdout } from "ink";
import type { ReactNode } from "react";
import { AsciiLogo } from "./AsciiLogo";
import { CapabilityRow } from "./CapabilityRow";
import { HomeFooter } from "./HomeFooter";
import { PromptCard } from "./PromptCard";

export interface HomeScreenData {
  logoWord: string;
  subtitle: string;
  promptExamples: readonly string[];
  capabilities: readonly string[];
  repository: string;
  branch: string;
  providerName: string;
  provider: string;
}

export interface HomeScreenProps extends HomeScreenData {
  renderPrompt: (placeholder: string) => ReactNode;
}

const LAYOUT = {
  contentSidePadding: 4,
  preferredPromptWidth: 68,
  minimumPromptWidth: 28,
} as const;

/** The focused, pre-conversation experience for an agent workspace. */
export function HomeScreen({
  logoWord,
  subtitle,
  promptExamples,
  capabilities,
  repository,
  branch,
  provider,
  renderPrompt,
}: HomeScreenProps) {
  const { stdout } = useStdout();
  const terminalWidth = stdout.columns ?? LAYOUT.preferredPromptWidth;
  const promptWidth = Math.min(
    LAYOUT.preferredPromptWidth,
    Math.max(LAYOUT.minimumPromptWidth, terminalWidth - LAYOUT.contentSidePadding),
  );

  return (
    <Box flexDirection="column" flexGrow={1} justifyContent="center">
      <Box flexDirection="column" alignItems="center">
        <AsciiLogo word={logoWord} />
        <Box marginTop={1} marginBottom={3}>
          <Text dimColor>{subtitle}</Text>
        </Box>
      </Box>

      <Box justifyContent="center" width="100%" marginTop={3}>
        <PromptCard width={promptWidth} examples={promptExamples}>
          {renderPrompt}
        </PromptCard>
      </Box>

      <Box justifyContent="center" width="100%" marginTop={1}>
        <CapabilityRow capabilities={capabilities} />
      </Box>

      <Box justifyContent="center" width="100%" marginTop={3}>
        <HomeFooter repository={repository} branch={branch} provider={provider} />
      </Box>
    </Box>
  );
}
