import { ApprovalMode } from "./approval-mode";
import { CommandRisk } from "./classifier";

/**
 * Given a risk level and the current mode, is approval required?
 *
 * That is the whole responsibility. It knows nothing about shell syntax and
 * nothing about the UI, which is what lets the runtime ask one question and lets
 * a new mode be one entry in this table.
 */
export interface ApprovalPolicy {
  readonly mode: ApprovalMode;
  requiresApproval(risk: CommandRisk): boolean;
  /** The highest risk this mode runs unattended, for describing the mode. */
  readonly autoApprovesUpTo: CommandRisk | null;
}

/**
 * The most severe risk each mode will run without asking. `null` means nothing
 * runs unattended.
 *
 * Every mode below FULL_AUTO stops at DESTRUCTIVE and SYSTEM, so deleting work
 * and touching the machine always ask — that is the guarantee the modes are
 * arranged around, not an incidental consequence of the ordering.
 */
const AUTO_APPROVES_UP_TO: Record<ApprovalMode, CommandRisk | null> = {
  [ApprovalMode.ALWAYS_ASK]: null,
  [ApprovalMode.AUTO_READ_ONLY]: CommandRisk.READ_ONLY,
  [ApprovalMode.AUTO_WORKSPACE]: CommandRisk.WORKSPACE_WRITE,
  [ApprovalMode.FULL_AUTO]: CommandRisk.SYSTEM,
};

export function requiresApproval(mode: ApprovalMode, risk: CommandRisk): boolean {
  const ceiling = AUTO_APPROVES_UP_TO[mode];
  if (ceiling === null) return true;

  return risk > ceiling;
}

export function createApprovalPolicy(mode: ApprovalMode): ApprovalPolicy {
  return {
    mode,
    autoApprovesUpTo: AUTO_APPROVES_UP_TO[mode],
    requiresApproval: (risk) => requiresApproval(mode, risk),
  };
}
