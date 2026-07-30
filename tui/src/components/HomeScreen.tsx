import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { AsciiLogo } from "./AsciiLogo";
import { CapabilityRow } from "./CapabilityRow";
import { HomeFooter } from "./HomeFooter";
import { PromptCard } from "./PromptCard";
import { colors } from "../styles/theme";
import { planLayout } from "../layout";
import { useTerminalSize } from "../hooks/useTerminalSize";

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
  /**
   * True while the slash-command list is open. The list renders in flow above
   * the composer and needs real rows, so the decoration steps aside for it
   * rather than being overlapped by it.
   */
  paletteOpen?: boolean;
}

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
  paletteOpen = false,
}: HomeScreenProps) {
  const { width, height } = useTerminalSize();
  const layout = planLayout(width, height);
  const showWordmark = layout.wordmark !== "hidden" && !paletteOpen;

  return (
    <Box flexDirection="column" flexGrow={1} justifyContent="space-between">
      <Box flexGrow={1} flexDirection="column" justifyContent="center">
        {showWordmark && (
          <Box flexDirection="column" alignItems="center">
            <AsciiLogo
              word={logoWord}
              variant={layout.wordmark === "full" ? "full" : "compact"}
            />
            {layout.showSubtitle && (
              <Box marginTop={1} marginBottom={layout.rhythm}>
                <Text color={colors.textMuted} wrap="truncate-end">
                  {subtitle}
                </Text>
              </Box>
            )}
          </Box>
        )}

        <Box justifyContent="center" width="100%" marginTop={layout.rhythm}>
          <PromptCard width={layout.contentWidth} examples={promptExamples}>
            {renderPrompt}
          </PromptCard>
        </Box>

        {layout.showCapabilities && !paletteOpen && (
          <Box justifyContent="center" width="100%" marginTop={1}>
            <CapabilityRow capabilities={capabilities} />
          </Box>
        )}
      </Box>

      {layout.showHomeFooter && (
        <Box width="100%" marginBottom={1}>
          <HomeFooter />
        </Box>
      )}
    </Box>
  );
}
