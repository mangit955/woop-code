import { getApprovalMode } from "../config/config";
import { CommandRisk, classifyCommand, createApprovalPolicy } from "../runtime/approval";
import { store } from "../tui/src/store/ui-store";

export interface CommandApprovalResult {
  approved: boolean;
  risk: CommandRisk;
  /** True when the policy allowed it without asking the user. */
  auto: boolean;
}

/**
 * The one place a shell command is cleared to run.
 *
 * Both command tools call this, so the decision reads the same way in each and
 * there is a single seam between "what kind of command is this" (the classifier),
 * "should we ask" (the policy) and "ask" (the UI). Neither tool contains a list
 * of command names.
 */
export async function requestCommandApproval(
  command: string,
  toolName: "run_terminal" | "run_tests",
): Promise<CommandApprovalResult> {
  const risk = classifyCommand(command);
  const policy = createApprovalPolicy(await getApprovalMode());

  if (!policy.requiresApproval(risk)) {
    return { approved: true, risk, auto: true };
  }

  const approved = await store.setPendingCommand({
    id: crypto.randomUUID(),
    command,
    toolName,
    risk,
  });

  return { approved, risk, auto: false };
}
