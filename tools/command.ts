import { readFileSync } from "node:fs";

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
  // `Bun.spawnSync` throws outright when the executable is missing, and `pgrep`
  // is not installed everywhere — a minimal container is enough to lose it. This
  // runs while a command is being killed, so a throw here would escape into a
  // timer callback and strand the caller; an empty list just means the other
  // signals do the work.
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync({ cmd: ["pgrep", "-P", String(pid)], stdout: "pipe", stderr: "ignore" });
  } catch {
    return [];
  }

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

/**
 * The process group a pid belongs to, or null when it cannot be determined.
 *
 * Read from /proc, which exists precisely where `setsid` does. The comm field
 * can itself contain spaces and brackets, so the fields are counted from the
 * last ')' rather than by splitting the whole line.
 */
function processGroupOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const pgrp = Number(fields[2]); // state, ppid, pgrp
    return Number.isInteger(pgrp) ? pgrp : null;
  } catch {
    return null;
  }
}

/**
 * Signals the command's process group, but only once it is confirmed to be the
 * command's own.
 *
 * A negative pid addresses a whole group, and getting that wrong is the worst
 * failure available here: if the command never became a group leader, this pid's
 * group is the one Woopcode itself is running in, and the signal takes down the
 * agent — or, under a CI runner, the shell the job is executing in. `setsid`
 * forks when it is already a leader, which is exactly the case where the pid we
 * hold is not the leader we assumed. Confirming pgrp === pid costs one small
 * read and turns a catastrophic misfire into a skipped optimisation.
 */
function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (processGroupOf(pid) !== pid) return false;
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

/**
 * Stops the command, and never throws.
 *
 * Both callers run inside a timer or an abort listener and report the outcome
 * immediately afterwards, so an exception raised here does not just fail to kill
 * anything — it escapes before the timeout or cancellation is reported, leaving
 * the promise nobody settles and the caller waiting for a command that is still
 * running. Killing is best-effort by nature; failing to kill must stay a
 * best-effort failure rather than becoming a hang.
 */
function terminateProcessTree(proc: ReturnType<typeof Bun.spawn>, processGroup: boolean) {
  if (proc.exitCode !== null) return;

  try {
    signalEverything(proc, processGroup, "SIGTERM");
  } catch {
    // Reported by the caller as a timeout or cancellation either way.
  }

  const forceKillTimer = setTimeout(() => {
    try {
      signalEverything(proc, processGroup, "SIGKILL");
    } catch {
      // Same: the bounded wait below is what guarantees a return.
    }
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

const STDOUT_MARKER = "\n\nSTDOUT:\n";
const STDERR_MARKER = "\n\nSTDERR:\n";

/**
 * Reads back what `formatCommandResult` wrote.
 *
 * Lives beside the formatter on purpose. Anything wanting the exit code or a
 * stream out of a tool result previously had to re-derive the layout, and one
 * caller got it wrong in a way nothing caught: taking "the last non-empty line"
 * of a successful command yields the literal string "STDERR:", because that is
 * the trailing label when the stream is empty. 71% of the recorded execution
 * log was that label rather than an outcome.
 *
 * Returns null for text this did not produce, so callers can fall back rather
 * than pretend a parse succeeded.
 */
export function parseCommandResult(text: string): CommandResult | null {
  if (!text.startsWith("Exit code: ")) return null;

  const stdoutAt = text.indexOf(STDOUT_MARKER);
  if (stdoutAt === -1) return null;

  const exitCode = Number.parseInt(text.slice("Exit code: ".length, stdoutAt), 10);
  if (!Number.isFinite(exitCode)) return null;

  // stderr is written last, so the final marker is the real separator. A
  // command whose own output contains the marker can still split wrongly;
  // the result is only ever used to build a short summary, so a rare
  // mis-split degrades the summary rather than the run.
  const stderrAt = text.lastIndexOf(STDERR_MARKER);
  if (stderrAt === -1 || stderrAt < stdoutAt) return null;

  return {
    exitCode,
    stdout: text.slice(stdoutAt + STDOUT_MARKER.length, stderrAt),
    stderr: text.slice(stderrAt + STDERR_MARKER.length),
  };
}
