import { getApprovalMode } from "../config/config";
import { CommandRisk, classifyCommand, createApprovalPolicy } from "../runtime/approval";
import { classifyCode, codeShellsOut } from "../runtime/toolEffects";
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
  toolName: ApprovedToolName,
): Promise<CommandApprovalResult> {
  return decide(command, toolName, classifyCommand(command));
}

/** The tools that clear something to run through this module. */
export type ApprovedToolName = "run_terminal" | "run_tests" | "repl" | "process_start";

/**
 * The same decision for interpreter source rather than a shell command.
 *
 * The shell classifier cannot be reused here: it reads `;` and `|` as command
 * separators and `>` as a redirect, which in Python and JavaScript are a
 * statement separator, bitwise-or and a comparison. Running it over source
 * grades ordinary arithmetic as destructive, so the model would be asked to
 * approve `value >> 16`.
 *
 * Three grades, failing closed at the one that cannot be read:
 *
 *  - Source that shells out is DESTRUCTIVE. `subprocess.run(argv)` builds its
 *    command at runtime, so there is nothing here to inspect, and unrecognised
 *    means destructive everywhere else in this codebase.
 *  - Source that writes a named file is WORKSPACE_WRITE.
 *  - Anything else is READ_ONLY. A REPL is mostly arithmetic over data already
 *    read, and grading that as risky would train the user to approve blindly.
 */
export async function requestCodeApproval(
  code: string,
  language: string,
): Promise<CommandApprovalResult> {
  const risk = codeShellsOut(code)
    ? CommandRisk.DESTRUCTIVE
    : classifyCode(code).writes
      ? CommandRisk.WORKSPACE_WRITE
      : CommandRisk.READ_ONLY;

  // Shown to the user as what it is: source for an interpreter, not a command
  // line. Without the prefix a multi-line Python block renders in the approval
  // dialog as though it were about to be handed to a shell.
  return decide(`${language}:\n${code}`, "repl", risk);
}

async function decide(
  command: string,
  toolName: ApprovedToolName,
  risk: CommandRisk,
): Promise<CommandApprovalResult> {
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
