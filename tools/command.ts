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

function terminateProcessTree(proc: ReturnType<typeof Bun.spawn>, processGroup: boolean) {
  if (proc.exitCode !== null) return;

  if (processGroup) {
    try {
      Bun.spawnSync({ cmd: ["kill", "-TERM", `-${proc.pid}`], stdout: "ignore", stderr: "ignore" });
    } catch {
      signalProcess(proc.pid, "SIGTERM");
    }
  } else {
    // macOS does not ship `setsid`. Kill descendants before the shell so
    // foreground pipelines and test runners cannot outlive the timeout.
    const descendants = descendantPids(proc.pid);
    for (const pid of descendants) {
      signalProcess(pid, "SIGTERM");
    }
    signalProcess(proc.pid, "SIGTERM");
  }

  const forceKillTimer = setTimeout(() => {
    try {
        if (processGroup) Bun.spawnSync({ cmd: ["kill", "-KILL", `-${proc.pid}`], stdout: "ignore", stderr: "ignore" });
      else signalProcess(proc.pid, "SIGKILL");
    } catch {
      signalProcess(proc.pid, "SIGKILL");
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
