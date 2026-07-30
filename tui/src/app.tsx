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
import { ApprovalPicker } from "./components/ApprovalPicker";
import { CommandApproval } from "./components/CommandApproval";
import { QuestionDialog } from "./components/QuestionDialog";
import type { AgentController } from "../../commands/agentController";
import type { ActiveTurn, TimeLineItem } from "./types";
import { useEffect, useRef, useState } from "react";
import { useTerminalSize } from "./hooks/useTerminalSize";
import { useCancelKey } from "./hooks/useCancelKey";
import { planLayout } from "./layout";
import { PaletteProvider } from "./styles/palette";
import { getModelDisplayName } from "../../config/client";
import { matchCommands } from "../../commands/slash/match";

interface AppProps {
  controller: AgentController;
  onExit: () => Promise<void>;
  homeScreen: HomeScreenData;
}

export function App({ controller, onExit, homeScreen }: AppProps) {
  const state = useUIStore();
  const [promptValue, setPromptValue] = useState("");
  const { width, height } = useTerminalSize();
  const layout = planLayout(width, height);
  const showHome = state.timeline.length === 0;
  // The command list takes rows from whatever is behind it, so the home screen
  // has to know it is open.
  const paletteOpen = matchCommands(promptValue).length > 0;
  const hasPendingEdit = state.pendingEdit !== null;
  const hasPendingCommand = state.pendingCommand !== null;
  const hasPendingQuestion = state.pendingQuestion !== null;
  // These float over the app rather than replacing it, so the work behind them
  // stays readable. The diff preview is not one of them: it splits the screen.
  const dialogOpen =
    state.modelPickerOpen ||
    state.approvalPickerOpen ||
    hasPendingCommand ||
    hasPendingQuestion;

  // Registered here because App is the only component that is always mounted.
  // Every modal below replaces the composer, which is where this used to live.
  useCancelKey({ controller, onExit });

  const promptProps = {
    controller,
    onExit,
    value: promptValue,
    onValueChange: setPromptValue,
    providerName: homeScreen.providerName,
    modelName: getModelDisplayName(state.selectedModel ?? undefined),
    showProvider: layout.showComposerProvider,
    // The composer stays on screen under a dialog, so it has to stop taking
    // keystrokes — otherwise typing in a dialog would also type into it.
    inputActive: !dialogOpen,
  };

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      backgroundColor="#000000"
    >
      {/* Everything behind a dialog renders in the faded palette, so the panel
          above reads as the foreground instead of the app going black. */}
      <PaletteProvider dimmed={dialogOpen}>
        {/* Header — pinned at top */}
        <Box flexShrink={0} paddingX={1}>
          <Header branch={homeScreen.branch} provider={homeScreen.providerName} />
        </Box>

      {/* Main content */}
      <Box flexDirection="column" flexGrow={1} minHeight={0} paddingX={1} backgroundColor="#000000">
        {showHome ? (
          <HomeScreen
            {...homeScreen}
            paletteOpen={paletteOpen}
            renderPrompt={(placeholder) => (
              <Prompt {...promptProps} placeholder={placeholder} variant={layout.composer} />
            )}
          />
        ) : hasPendingEdit ? (
          /* Split layout: Timeline on top, Diff below */
          <Box flexDirection="column" flexGrow={1} minHeight={0} backgroundColor="#000000">
            <ConversationViewport
              items={state.timeline}
              isThinking={state.isThinking}
              activeTurn={state.activeTurn}
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
            activeTurn={state.activeTurn}
            scrollOffset={state.scrollOffset}
            updateKey={state}
            layoutKey={`${width}:${height}`}
            flexGrow={1}
          />
        )}
      </Box>

      {/* Footer — pinned at bottom. Its rows are fixed, so in a short terminal
          the decorations come off before the input does: the status bar first,
          then the surrounding gap, then the border itself. */}
      {!showHome && !hasPendingEdit && (
        <Box
          flexDirection="column"
          flexShrink={0}
          paddingX={1}
          gap={layout.showStatusBar ? 1 : 0}
          marginBottom={layout.showStatusBar ? 1 : 0}
        >
          <Prompt {...promptProps} variant={layout.composer} />
          {layout.showStatusBar && <ConnectedStatusBar />}
        </Box>
      )}
      </PaletteProvider>

      {/* Dialog layer — last child and absolutely positioned, so it paints over
          the content above while leaving it visible around the panel. */}
      {dialogOpen && (
        <Box
          position="absolute"
          top={0}
          left={0}
          width={width}
          height={height}
          alignItems="center"
          justifyContent="center"
        >
          <PaletteProvider dimmed={false}>
            {state.modelPickerOpen ? (
              <ModelPicker controller={controller} selectedModel={state.selectedModel} />
            ) : state.approvalPickerOpen ? (
              <ApprovalPicker mode={state.approvalMode} />
            ) : hasPendingCommand ? (
              <CommandApproval command={state.pendingCommand!} />
            ) : (
              <QuestionDialog question={state.pendingQuestion!} />
            )}
          </PaletteProvider>
        </Box>
      )}
    </Box>
  );
}

interface ConversationViewportProps {
  items: TimeLineItem[];
  isThinking: boolean;
  activeTurn: ActiveTurn | null;
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
  activeTurn,
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
        <Timeline items={items} isThinking={isThinking} activeTurn={activeTurn} />
      </Box>
    </Box>
  );
}
