import { getApprovalMode } from "../config/config";
import { CommandRisk, classifyCommand, createApprovalPolicy } from "../runtime/approval";
import { isSandboxed } from "../runtime/sandbox";
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
  // Where it will run is part of how risky it is: `chmod -R 777 /` in a virtual
  // machine that is about to be discarded cannot touch anything of the user's,
  // and prompting for it anyway is how a user learns to click through the
  // dialog that mattered. The classifier decides what that is worth — this only
  // tells it where.
  //
  // `isSandboxed()` is `!== "local"`, so an executor kind added later is
  // uncontained until it says otherwise. Read once and passed down rather than
  // asked again below: one decision should not be able to grade a command
  // against one answer and describe it to the user with the other.
  const contained = isSandboxed();

  return decide(command, toolName, classifyCommand(command, { contained }), contained);
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

  // The risk itself is unchanged by containment: these three grades are about
  // what the source *does*, and source that shells out builds its command at
  // runtime, so there is nothing to reason about no matter where it runs. Only
  // the "where" shown to the user comes from the executor.
  //
  // Shown to the user as what it is: source for an interpreter, not a command
  // line. Without the prefix a multi-line Python block renders in the approval
  // dialog as though it were about to be handed to a shell.
  return decide(`${language}:\n${code}`, "repl", risk, isSandboxed());
}

async function decide(
  command: string,
  toolName: ApprovedToolName,
  risk: CommandRisk,
  sandboxed: boolean,
): Promise<CommandApprovalResult> {
  const policy = createApprovalPolicy(await getApprovalMode());

  if (!policy.requiresApproval(risk)) {
    return { approved: true, risk, auto: true };
  }

  // Told to the human, not used to decide anything: a command that reaches this
  // dialog is one we are asking about, and `chmod -R 777 /` reads very
  // differently depending on whose filesystem it is about to land on.
  const approved = await store.setPendingCommand({
    id: crypto.randomUUID(),
    command,
    toolName,
    risk,
    sandboxed,
  });

  return { approved, risk, auto: false };
}
