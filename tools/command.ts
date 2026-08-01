export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

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

function signalProcess(pid: number, signal: NodeJS.Signals) {
  // Bun's Process.kill can signal its own process group on some platforms.
  // Delegating to the OS utility makes the positive PID semantics explicit.
  Bun.spawnSync({ cmd: ["kill", `-${signal.replace("SIG", "")}`, String(pid)], stdout: "ignore", stderr: "ignore" });
}

/**
 * Signals a whole process group, reporting whether the signal actually landed.
 *
 * `Bun.spawnSync` resolves for a `kill` that ran and failed — a wrong group id
 * exits non-zero rather than throwing — so a `try/catch` here would report
 * success for a signal nobody received. The exit status is the only honest
 * answer, and the caller needs it to know whether to fall back.
 */
function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  const result = Bun.spawnSync({
    cmd: ["kill", `-${signal.replace("SIG", "")}`, `-${pid}`],
    stdout: "ignore",
    stderr: "ignore",
  });

  return result.success;
}

/** Signals every descendant, then the shell itself. */
function signalTree(pid: number, signal: NodeJS.Signals) {
  for (const descendant of descendantPids(pid)) {
    signalProcess(descendant, signal);
  }
  signalProcess(pid, signal);
}

function terminateProcessTree(proc: ReturnType<typeof Bun.spawn>, processGroup: boolean) {
  if (proc.exitCode !== null) return;

  // A group kill is preferred where `setsid` gave the command its own group, but
  // it is not guaranteed to land: `setsid` forks when it is already a group
  // leader, and the new leader's id is then not this pid. When that happens the
  // signal reaches nothing, the command runs to completion, and the timeout the
  // caller asked for is silently not honoured. Falling back to the tree walk
  // that platforms without `setsid` already use keeps one behaviour everywhere.
  if (!processGroup || !signalProcessGroup(proc.pid, "SIGTERM")) {
    signalTree(proc.pid, "SIGTERM");
  }

  const forceKillTimer = setTimeout(() => {
    if (!processGroup || !signalProcessGroup(proc.pid, "SIGKILL")) {
      signalTree(proc.pid, "SIGKILL");
    }
  }, 500);
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
    // Do not return from a timeout/cancellation until the process group has
    // actually exited. Otherwise a following tool call can race a dying test
    // runner that is still holding files or ports.
    if (proc.exitCode === null) {
      await proc.exited;
    }
  }
}

export function formatCommandResult(result: CommandResult) {
  return `Exit code: ${result.exitCode}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}`;
}
