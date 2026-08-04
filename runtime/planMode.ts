/**
 * Plan mode: investigate and propose, change nothing.
 *
 * A session is in one of two modes, cycled with Tab. Build is what Woopcode has
 * always done. Plan is a state where reads and shell inspection run normally but
 * nothing may change the repository — so the agent can look around and write a
 * proposal, and the user decides whether it happens.
 *
 * Nothing here is persisted and nothing here is a permission the model can widen.
 * The mode is a property of the session, chosen by the person at the keyboard;
 * there is deliberately no tool for leaving it.
 *
 * Two gates, both fed from this file:
 *
 *   1. The tool list sent to the provider omits every writing tool, so the model
 *      is not offered them at all.
 *   2. The loop refuses any write that arrives regardless.
 *
 * The second is not redundant. `run_terminal` has to stay available — inspection
 * is most of what planning is — and `sed -i`, `cat > file` or a `python3 -c` that
 * opens a file for writing all reach the filesystem through a tool the first gate
 * has to keep. A filtered tool list cannot see command arguments; only the
 * classifier can.
 */

import type { Tool } from "../config/types";
import { classifyCommand, commandOf, toolEffect } from "./toolEffects";

/** Which mode a session is in. Cycled with Tab; never written to config. */
export type SessionMode = "build" | "plan";

/**
 * The label shown in the composer and recorded on the turn footer.
 *
 * `TurnIdentity.agent` already carries a label of exactly this kind, so a turn
 * run while planning is identifiable in scrollback after the fact.
 */
export const SESSION_MODE_LABELS: Record<SessionMode, string> = {
  build: "Build",
  plan: "Plan",
};

export function sessionModeLabel(mode: SessionMode): string {
  return SESSION_MODE_LABELS[mode];
}

/**
 * The colour the mode is drawn in — label, caret, composer bar, Tab hint.
 *
 * One function rather than a conditional at each site, because four places
 * disagreeing about what "planning" looks like is how the bar ended up
 * periwinkle beside an amber label.
 *
 * The palette is an argument, the way `outcomeColor` in TurnFooter takes it, so
 * the colour fades with the layer it renders in — a composer behind a dialog is
 * drawn from the dimmed palette and this follows it there.
 *
 * Build stays on `primary`: the theme's `agentBuild` is a different indigo, and
 * adopting it here would restyle Build as a side effect of adding Plan.
 */
export function sessionModeColor(
  mode: SessionMode,
  colors: { primary: string; agentPlan: string },
): string {
  return mode === "plan" ? colors.agentPlan : colors.primary;
}

/** The other mode. Tab has only two stops, so cycling is a flip. */
export function nextSessionMode(mode: SessionMode): SessionMode {
  return mode === "plan" ? "build" : "plan";
}

/**
 * Tool effects a planning turn may use.
 *
 * `shell` is absent on purpose: whether a command is allowed depends on the
 * command, not on the tool, so it is decided per call in `blockedInPlanMode`.
 * Anything not listed — including `unclassified`, which is what an added tool
 * reads as until someone classifies it — is refused. Failing closed is the only
 * defensible default for a mode whose whole promise is that nothing changes.
 */
const PLANNABLE_EFFECTS = new Set(["read", "ask", "plan"]);

/**
 * The tools offered to the provider while planning.
 *
 * Derived from the effects table rather than from a list of names kept here,
 * because a second list is how the two drift: a writing tool added later is
 * withheld automatically, and one whose effect nobody recorded is withheld too.
 */
export function planModeTools(registry: readonly Tool[]): Tool[] {
  return registry.filter((tool) => {
    const effect = toolEffect(tool.name);
    return effect === "shell" || PLANNABLE_EFFECTS.has(effect);
  });
}

/**
 * Would this call change the repository?
 *
 * Judged from the effects table for a tool, and from the command itself for a
 * shell tool — the same `classifyCommand` the runtime already uses to tell an
 * edit from a verification, so there is no second table of command names to keep
 * in step with the first.
 */
export function blockedInPlanMode(
  name: string,
  args: Record<string, unknown> = {},
): boolean {
  const effect = toolEffect(name);

  if (effect === "shell") return classifyCommand(commandOf(args)).writes;

  return !PLANNABLE_EFFECTS.has(effect);
}

/**
 * What the model is told when a write is refused.
 *
 * Written for the model, which is the audience for every tool result: it says
 * the file is unchanged, so the turn cannot go on to report the change as
 * applied, and it says what to do instead, so the refusal is a redirection
 * rather than a dead end.
 */
export function planModeRefusal(name: string): string {
  return (
    `Not applied: ${name} was refused because this session is in plan mode. ` +
    `Nothing was written and the workspace is unchanged. ` +
    `Do not attempt another way of writing it — every writing tool and any shell ` +
    `command that edits a file is refused while planning, including redirects and ` +
    `sed -i. Finish investigating and reply with the plan in prose: what you would ` +
    `change, in which files, and how it would be verified. The user leaves plan ` +
    `mode themselves once they have read it.`
  );
}
