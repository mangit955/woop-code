export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/** How long a SIGKILLed process is given to disappear before we stop waiting. */
const EXIT_GRACE_MS = 750;

/** How long SIGTERM is given to work before SIGKILL follows. */
const FORCE_KILL_AFTER_MS = 500;

function childPids(pid: number): number[] {
  const result = Bun.spawnSync({ cmd: ["pgrep", "-P", String(pid)], stdout: "pipe", stderr: "ignore" });
  return new TextDecoder().decode(result.stdout)
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((childPid) => Number.isInteger(childPid) && childPid > 0);
}

function descendantPids(pid: number, seen = new Set<number>()): number[] {
  const directChildren = childPids(pid).filter((childPid) => !seen.has(childPid));
  for (const childPid of directChildren) seen.add(childPid);
  return directChildren.flatMap((childPid) => [
    ...descendantPids(childPid, seen),
    childPid,
  ]);
}

/**
 * Sends a signal, reporting whether it was delivered.
 *
 * `process.kill` is the `kill(2)` syscall: it needs no `kill` binary on PATH and
 * it throws when the target does not exist, so a failure is visible. Spawning
 * `kill` instead — which is what this did — cannot fail loudly, because
 * `Bun.spawnSync` resolves for a command that ran and exited non-zero. Every
 * signal on the timeout path was therefore best-effort with no way to tell.
 *
 * A negative pid addresses a process group, which is why the group and single
 * cases share this one function.
 */
function sendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    // ESRCH means it is already gone, which is the outcome we wanted anyway.
    // Anything else falls through to the caller's next attempt.
    return false;
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  return sendSignal(pid, signal);
}

/** A negative pid addresses the whole process group. */
function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  return sendSignal(-pid, signal);
}

/**
 * Every way of reaching the command, in order of reliability.
 *
 * No single one is dependable. The direct signal always reaches the process Bun
 * spawned but not the children it started; the group signal reaches everything
 * at once but only when `setsid` really made this pid the group leader — it
 * forks when it is already one, and the leader is then a pid we never saw; the
 * tree walk reaches children but depends on `pgrep`. Doing all three costs a few
 * syscalls against a process that is being killed anyway, and means no single
 * failure leaves the command running.
 */
function signalEverything(
  proc: ReturnType<typeof Bun.spawn>,
  processGroup: boolean,
  signal: NodeJS.Signals,
) {
  if (processGroup) signalProcessGroup(proc.pid, signal);
  for (const descendant of descendantPids(proc.pid)) signalProcess(descendant, signal);
  signalProcess(proc.pid, signal);
}

function terminateProcessTree(proc: ReturnType<typeof Bun.spawn>, processGroup: boolean) {
  if (proc.exitCode !== null) return;

  signalEverything(proc, processGroup, "SIGTERM");

  const forceKillTimer = setTimeout(() => {
    signalEverything(proc, processGroup, "SIGKILL");
  }, FORCE_KILL_AFTER_MS);
  forceKillTimer.unref?.();
  // Bun reports null for a process killed by a signal, so exitCode cannot be
  // used to guard this timer. Always clear it when the original process exits
  // to avoid signalling a PID that the OS has already reused.
  void proc.exited.finally(() => clearTimeout(forceKillTimer));
}

export async function runCommand(
  command: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (signal?.aborted) throw new Error("Command cancelled");

  // On platforms with setsid, give the command a dedicated process group so
  // all children can be stopped together. macOS uses the tree-kill fallback.
  const setsid = Bun.which("setsid");
  const processGroup = Boolean(setsid);
  const proc = Bun.spawn({
    cmd: processGroup ? [setsid!, "sh", "-c", command] : ["sh", "-c", command],
    stdout: "pipe",
    stderr: "pipe",
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let aborted = false;
  let rejectWait: ((error: Error) => void) | undefined;
  const abort = () => {
    aborted = true;
    terminateProcessTree(proc, processGroup);
    rejectWait?.(new Error("Command cancelled"));
  };

  const completion = new Promise<void>((resolve, reject) => {
    rejectWait = reject;
    void proc.exited.then(() => resolve());
  });
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      terminateProcessTree(proc, processGroup);
      reject(new Error(`Command timed out after ${timeoutSeconds} seconds`));
    }, timeoutSeconds * 1000);
  });

  signal?.addEventListener("abort", abort, { once: true });
  try {
    await Promise.race([completion, timeout]);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { stdout, stderr, exitCode: proc.exitCode ?? (aborted ? 143 : 1) };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abort);
    // Give the process a moment to die before returning, so a following tool
    // call does not race a dying test runner that still holds files or ports.
    //
    // Bounded, because this used to be an unbounded `await proc.exited`: if a
    // signal failed to land, the wait lasted as long as the command would have
    // taken anyway, and a timeout stopped being a timeout. A cancellation the
    // user asked for has to return whether or not the process cooperated.
    if (proc.exitCode === null) {
      await Promise.race([proc.exited, Bun.sleep(EXIT_GRACE_MS)]);
    }
  }
}

export function formatCommandResult(result: CommandResult) {
  return `Exit code: ${result.exitCode}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}`;
}
