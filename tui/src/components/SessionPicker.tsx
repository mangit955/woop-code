import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useMemo, useState } from "react";
import { listSessions, type SessionSummary } from "../../../config/sessions";
import type { AgentController } from "../../../commands/agentController";
import { store } from "../store/ui-store";
import { usePalette } from "../styles/palette";
import { planLayout, windowAround } from "../layout";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { relativeTime } from "../relative-time";

interface SessionPickerProps {
  controller: AgentController;
}

export function SessionPicker({ controller }: SessionPickerProps) {
  const colors = usePalette();
  const [query, setQuery] = useState("");
  const [showCursor, setShowCursor] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  /**
   * Scope starts at this project, which is what someone opening the picker
   * almost always wants. Widening is one key away and is the only way to reach
   * migrated pre-sessions history, which belongs to no project.
   */
  const [allProjects, setAllProjects] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSessions(null);
    listSessions({ scope: allProjects ? "all" : "project" })
      .then((found) => {
        if (!cancelled) {
          setSessions(found);
          setSelectedIndex(0);
        }
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setSessions([]);
        setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [allProjects]);

  // Optional-called for the same reason /status does it: the picker is reachable
  // from contexts holding a partly-wired controller, and failing to draw is a
  // worse answer than drawing without the active marker.
  const activeId = controller.currentSession?.()?.id;

  const matches = useMemo(() => {
    const needle = query.toLowerCase();
    if (!needle) return sessions ?? [];
    return (sessions ?? []).filter(
      (session) =>
        session.title.toLowerCase().includes(needle) ||
        (session.name?.toLowerCase().includes(needle) ?? false) ||
        session.id.startsWith(needle),
    );
  }, [sessions, query]);

  const { width, height } = useTerminalSize();
  const layout = planLayout(width, height);
  const listRows = Math.max(
    1,
    layout.dialogListRows - (error && !layout.showDialogHints ? 1 : 0),
  );
  const visible = windowAround(selectedIndex, matches.length, listRows);
  const hiddenAbove = visible.start;
  const hiddenBelow = matches.length - visible.end;

  useEffect(() => {
    const interval = setInterval(() => setShowCursor((on) => !on), 530);
    return () => clearInterval(interval);
  }, []);

  const close = () => store.closeSessionPicker();

  const choose = async () => {
    const session = matches[selectedIndex];
    if (!session || switching) return;

    if (session.id === activeId) {
      close();
      return;
    }

    setSwitching(true);
    setError(null);

    try {
      const record = await controller.switchSession(session.id);
      if (!record) {
        // isBusy is the likely cause: switching mid-turn would attribute the
        // reply in flight to the session being left.
        setError("Could not switch sessions right now.");
        setSwitching(false);
        return;
      }
      // Redraws the transcript and closes the picker in one update.
      store.hydrateTimeline(record.messages);
      store.addSystemMessage(`Resumed ${record.name ?? record.title}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setSwitching(false);
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      if (!switching) close();
      return;
    }
    // Ctrl+A widens to every project on this machine. Checked before the arrow
    // keys so a terminal that also sends it as a control character cannot fall
    // through into navigation.
    if (key.ctrl && input.toLowerCase() === "a") {
      setAllProjects((widened) => !widened);
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(matches.length - 1, current + 1));
      return;
    }
    if (key.return) void choose();
  });

  const scopeLabel = allProjects ? "All projects" : "This project";

  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
      <Box
        flexDirection="column"
        width={layout.dialogWidth}
        paddingX={layout.dialogWidth < 40 ? 1 : 3}
        paddingY={1}
        backgroundColor={colors.bgElevated}
        borderStyle={layout.showDialogBorder ? "round" : undefined}
        borderColor={colors.borderElevated}
      >
        <Box justifyContent="space-between" marginBottom={layout.dialogRhythm}>
          <Text bold color={colors.textStrong}>Resume session</Text>
          <Text color={colors.textFaint}>{switching ? "switching…" : "esc"}</Text>
        </Box>
        <Box marginBottom={layout.dialogRhythm}>
          <TextInput
            value={query}
            placeholder="Search"
            showCursor={showCursor}
            onChange={(value) => {
              setQuery(value);
              setSelectedIndex(0);
              setShowCursor(true);
            }}
          />
        </Box>
        {layout.showDialogLabel && (
          <Text bold color={colors.secondary}>{scopeLabel}</Text>
        )}
        <Box flexDirection="column" marginTop={layout.dialogRhythm}>
          {sessions === null ? (
            <Text color={colors.textMuted}>Loading…</Text>
          ) : matches.length === 0 ? (
            <Text color={colors.textMuted}>
              {query
                ? "No matching sessions"
                : allProjects
                  ? "No saved sessions yet"
                  : "No sessions in this project — Ctrl+A for all projects"}
            </Text>
          ) : (
            <>
              {layout.showDialogScrollIndicators && hiddenAbove > 0 && (
                <Text color={colors.textFaint}>{`  ↑ ${hiddenAbove} more`}</Text>
              )}
              {matches.slice(visible.start, visible.end).map((session, offset) => {
                const index = visible.start + offset;
                const selected = index === selectedIndex;
                const label = session.name ?? session.title;
                return (
                  <Box
                    key={session.id}
                    paddingX={1}
                    backgroundColor={selected ? colors.selectionBg : undefined}
                  >
                    <Text color={selected ? colors.selectionFg : colors.textMuted}>
                      {session.id === activeId ? "● " : selected ? "› " : "  "}
                    </Text>
                    <Box flexShrink={1} minWidth={0}>
                      <Text
                        bold={selected}
                        color={selected ? colors.selectionFg : colors.textBase}
                        wrap="truncate-end"
                      >
                        {label}
                      </Text>
                    </Box>
                    <Box flexGrow={1} />
                    {layout.dialogWidth >= 40 && (
                      <Text color={selected ? colors.selectionFg : colors.textFaint}>
                        {relativeTime(session.updated)}
                      </Text>
                    )}
                  </Box>
                );
              })}
              {layout.showDialogScrollIndicators && hiddenBelow > 0 && (
                <Text color={colors.textFaint}>{`  ↓ ${hiddenBelow} more`}</Text>
              )}
            </>
          )}
        </Box>
        {error ? (
          <Box marginTop={layout.showDialogHints ? 1 : 0}>
            <Text color={colors.dangerBase} wrap="truncate-end">
              {error}
            </Text>
          </Box>
        ) : (
          layout.showDialogHints && (
            <Box marginTop={2} gap={3}>
              <Text color={colors.textBase}>Enter resume</Text>
              <Text color={colors.textFaint}>↑↓ navigate</Text>
              <Text color={colors.textFaint}>^A all projects</Text>
            </Box>
          )
        )}
      </Box>
    </Box>
  );
}
