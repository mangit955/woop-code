import { Box, measureElement, type DOMElement } from "ink";
import { Header } from "./header";
import { Timeline } from "./timeline";
import { ConnectedStatusBar } from "./statusBar";
import { Prompt } from "./prompt";
import { useUIStore } from "./store/useUIStore";
import { store } from "./store/ui-store";
import { HomeScreen, type HomeScreenData } from "./components/HomeScreen";
import { DiffPreview } from "./components/DiffPreview";
import { ModelPicker } from "./components/ModelPicker";
import { CommandApproval } from "./components/CommandApproval";
import { QuestionDialog } from "./components/QuestionDialog";
import type { AgentController } from "../../commands/agentController";
import type { TimeLineItem } from "./types";
import { useEffect, useRef, useState } from "react";
import { useTerminalSize } from "./hooks/useTerminalSize";
import { colors } from "./styles/theme";
import { getModelDisplayName } from "../../config/client";

interface AppProps {
  controller: AgentController;
  onExit: () => Promise<void>;
  homeScreen: HomeScreenData;
}

export function App({ controller, onExit, homeScreen }: AppProps) {
  const state = useUIStore();
  const [promptValue, setPromptValue] = useState("");
  const { width, height } = useTerminalSize();
  const showHome = state.timeline.length === 0;
  const hasPendingEdit = state.pendingEdit !== null;
  const hasPendingCommand = state.pendingCommand !== null;
  const hasPendingQuestion = state.pendingQuestion !== null;

  const promptProps = {
    controller,
    onExit,
    value: promptValue,
    onValueChange: setPromptValue,
    providerName: homeScreen.providerName,
    modelName: getModelDisplayName(state.selectedModel ?? undefined),
  };

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      backgroundColor="#000000"
    >
      {/* Header — pinned at top */}
      <Box flexShrink={0} paddingX={1}>
        <Header branch={homeScreen.branch} provider={homeScreen.providerName} />
      </Box>

      {state.modelPickerOpen ? (
        <ModelPicker controller={controller} selectedModel={state.selectedModel} />
      ) : hasPendingCommand ? (
        <CommandApproval command={state.pendingCommand!} />
      ) : hasPendingQuestion ? (
        <QuestionDialog question={state.pendingQuestion!} />
      ) : (
        <>

      {/* Main content */}
      <Box flexDirection="column" flexGrow={1} minHeight={0} paddingX={1} backgroundColor="#000000">
        {showHome ? (
          <HomeScreen
            {...homeScreen}
            renderPrompt={(placeholder) => (
              <Prompt {...promptProps} placeholder={placeholder} variant="block" />
            )}
          />
        ) : hasPendingEdit ? (
          /* Split layout: Timeline on top, Diff below */
          <Box flexDirection="column" flexGrow={1} minHeight={0} backgroundColor="#000000">
            <ConversationViewport
              items={state.timeline}
              isThinking={state.isThinking}
              scrollOffset={state.scrollOffset}
              updateKey={state}
              layoutKey={`${width}:${height}`}
              flexShrink={1}
            />

            {/* Diff preview - takes remaining space */}
            <Box
              flexDirection="column"
              flexGrow={1}
              flexShrink={1}
              minHeight={0}
              backgroundColor="#000000"
            >
              <DiffPreview pendingEdit={state.pendingEdit!} />
            </Box>
          </Box>
        ) : (
          <ConversationViewport
            items={state.timeline}
            isThinking={state.isThinking}
            scrollOffset={state.scrollOffset}
            updateKey={state}
            layoutKey={`${width}:${height}`}
            flexGrow={1}
          />
        )}
      </Box>

      {/* Footer — pinned at bottom */}
      {!showHome && !hasPendingEdit && !hasPendingCommand && !hasPendingQuestion && (
        <Box flexDirection="column" flexShrink={0} paddingX={1} gap={1} marginBottom={1}>
          <Prompt {...promptProps} variant="block" />
          <ConnectedStatusBar />
        </Box>
      )}
        </>
      )}
    </Box>
  );
}

interface ConversationViewportProps {
  items: TimeLineItem[];
  isThinking: boolean;
  scrollOffset: number;
  updateKey: object;
  layoutKey: string;
  flexGrow?: number;
  flexShrink?: number;
}

/**
 * Keeps the transcript pinned to its latest line until the user scrolls, while
 * clipping only this middle region. Header and composer live outside it.
 */
function ConversationViewport({
  items,
  isThinking,
  scrollOffset,
  updateKey,
  layoutKey,
  flexGrow,
  flexShrink,
}: ConversationViewportProps) {
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);

  const measurementTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (measurementTimer.current) return;

    // Streaming can cause dozens of updates per second. Measuring every frame
    // forces repeated terminal layouts, so coalesce it to a short interval.
    measurementTimer.current = setTimeout(() => {
      measurementTimer.current = undefined;
      if (!viewportRef.current || !contentRef.current) return;

      const viewportHeight = measureElement(viewportRef.current).height;
      const contentHeight = measureElement(contentRef.current).height;
      store.setScrollLimit(contentHeight - viewportHeight);
    }, 75);
  }, [updateKey, layoutKey]);

  useEffect(
    () => () => {
      if (measurementTimer.current) clearTimeout(measurementTimer.current);
    },
    [],
  );

  return (
    <Box
      ref={viewportRef}
      flexDirection="column-reverse"
      flexGrow={flexGrow}
      flexShrink={flexShrink}
      minHeight={0}
      overflow="hidden"
    >
      <Box flexGrow={1} />
      <Box
        ref={contentRef}
        flexDirection="column"
        flexShrink={0}
        marginBottom={-scrollOffset}
      >
        <Timeline items={items} isThinking={isThinking} />
      </Box>
    </Box>
  );
}
