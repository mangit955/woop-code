/**
 * Commands that outlive the call that started them.
 *
 * `run_terminal` refuses an unquoted `&` outright and kills anything still
 * running at its timeout, which is right for it — a tool that waits for output
 * cannot wait forever. But it left the agent with no way to start a server, a
 * watcher or a build it wants to keep an eye on, and the recorded benchmark
 * trials show it hitting that wall: background launches refused, and the model
 * told in the timeout message to give up and ask the user to test by hand.
 *
 * Three tools rather than a flag on `run_terminal`, because the shapes differ.
 * A backgrounded command has no exit code to return and no output to wait for,
 * so `process_start` answers with a handle, and reading and stopping are calls
 * of their own against that handle.
 *
 * Unlike the REPL, these deliberately survive the turn. A development server
 * started while answering one question has to still be up for the next; ending
 * it with the turn would make the tool useless for the thing it exists for.
 * They end at `process_stop`, at session exit, or when the process itself dies.
 */

import type { Tool } from "../config/types";
import { requestCommandApproval } from "./approval";
import { shellArgv, terminateProcessTree } from "./command";
import { resolveWorkspacePath } from "./workspace";

/**
 * Output kept per process, in characters.
 *
 * A ring rather than an unbounded buffer: a watcher left running for an hour
 * produces more than anything here could use, and the interesting part of a
 * server's output is almost always the newest — a stack trace it just printed,
 * not the banner from startup. When the cap is passed the oldest is dropped and
 * the reader is told, so a gap is never silently presented as the whole story.
 */
const MAX_BUFFERED_OUTPUT = 64 * 1024;

/** Characters of output returned by a single `process_output` call. */
const MAX_OUTPUT_RESULT = 16 * 1024;

interface BackgroundProcess {
  id: string;
  command: string;
  proc: ReturnType<typeof Bun.spawn>;
  /** Output not yet handed to `process_output`. */
  unread: string;
  /** Characters dropped from the front of `unread` to stay under the cap. */
  dropped: number;
  exitCode: number | null;
  startedAt: number;
  /** Whether the command got a process group, which decides how it is killed. */
  processGroup: boolean;
}

const processes = new Map<string, BackgroundProcess>();

/**
 * Short and readable: this id is quoted back by the model on every later call.
 *
 * Monotonic, and never reused even after the process it named is gone. Picking
 * the lowest free number instead would hand `bg1` to a second process once the
 * first was stopped, and a model still holding the old id — it has the whole
 * transcript, so it always might — would read or kill the wrong one and get a
 * plausible answer back. A counter that only goes up makes a stale id an error
 * rather than a mix-up.
 */
let issued = 0;

function nextId(): string {
  issued++;
  return `bg${issued}`;
}

function collect(record: BackgroundProcess, stream: ReadableStream<Uint8Array> | null): void {
  if (!stream) return;

  void (async () => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        record.unread += decoder.decode(value, { stream: true });
        if (record.unread.length > MAX_BUFFERED_OUTPUT) {
          const excess = record.unread.length - MAX_BUFFERED_OUTPUT;
          record.unread = record.unread.slice(excess);
          record.dropped += excess;
        }
      }
    } catch {
      // The process was killed mid-read, which is a normal end for this.
    }
  })();
}

function describe(record: BackgroundProcess): string {
  if (record.exitCode !== null) return `exited with code ${record.exitCode}`;
  const seconds = Math.round((Date.now() - record.startedAt) / 1000);
  return `running for ${seconds}s`;
}

/** Drains what has been buffered, bounding what is handed back. */
function drain(record: BackgroundProcess): string {
  let output = record.unread;
  record.unread = "";

  const dropped = record.dropped;
  record.dropped = 0;

  if (output.length > MAX_OUTPUT_RESULT) {
    const excess = output.length - MAX_OUTPUT_RESULT;
    // The newest is kept: the tail is what says what the process is doing now.
    output = output.slice(excess);
    return (
      `... ${excess + dropped} earlier characters dropped ...\n${output}`
    );
  }

  return dropped > 0 ? `... ${dropped} earlier characters dropped ...\n${output}` : output;
}

function requireProcess(args: Record<string, unknown>): BackgroundProcess {
  const id = args.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw Error("id is required and must be the string returned by process_start");
  }

  const record = processes.get(id.trim());
  if (!record) {
    const known = [...processes.keys()];
    throw Error(
      `No background process ${id}. ` +
        (known.length
          ? `Started processes: ${known.join(", ")}.`
          : "None have been started in this session."),
    );
  }

  return record;
}

export const processStartTool: Tool = {
  name: "process_start",
  description: `Starts a command in the background and returns immediately with an id.

Use it for anything that does not exit on its own — a development server, a watcher, a long build you want to follow. For a command that finishes and whose output you need, use run_terminal instead; it waits and returns the result in one call.

The process keeps running after this turn ends. Read what it has printed with process_output and end it with process_stop.`,

  parameters: [
    { name: "command", description: "Command to start", required: true },
    {
      name: "cwd",
      description: "Directory to run it in. Defaults to the project root.",
      required: false,
    },
  ],

  async execute(args) {
    const command = args.command;
    if (typeof command !== "string" || command.trim() === "") {
      throw Error("command is required and must be a non-empty string");
    }

    let cwd: string | undefined;
    if (args.cwd !== undefined) {
      if (typeof args.cwd !== "string") {
        throw Error("cwd must be a string path");
      }
      cwd = await resolveWorkspacePath(args.cwd, { mustExist: true });
    }

    const { approved } = await requestCommandApproval(command, "process_start");
    if (!approved) {
      return "Command rejected by user. Nothing was started.";
    }

    const id = nextId();
    // Its own process group, so stopping it stops what it started. Without
    // this the kill reaches the shell and nothing below it: measured, a
    // `python3 ... ; true` left its interpreter running after process_stop
    // returned, which is exactly the leak this tool claims to prevent.
    const { cmd, processGroup } = shellArgv(command);
    const proc = Bun.spawn({
      cmd,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const record: BackgroundProcess = {
      id,
      command,
      proc,
      unread: "",
      dropped: 0,
      exitCode: null,
      startedAt: Date.now(),
      processGroup,
    };
    processes.set(id, record);

    collect(record, proc.stdout as ReadableStream<Uint8Array> | null);
    collect(record, proc.stderr as ReadableStream<Uint8Array> | null);
    void proc.exited.then((code) => {
      record.exitCode = code;
    });

    // Nothing is waited for, so there is nothing to report but the handle. The
    // model is told what to call next, because a bare id reads as a dead end.
    return (
      `Started ${id}: ${command}\n\n` +
      `It is running in the background. Call process_output with id "${id}" to read ` +
      `what it has printed, and process_stop to end it. It is not waited for, so ` +
      `give it a moment before expecting output.`
    );
  },
};

export const processOutputTool: Tool = {
  name: "process_output",
  description:
    "Returns what a background process has printed since the last time this was called for it, along with whether it is still running. Output already returned is not repeated.",

  parameters: [
    { name: "id", description: "The id returned by process_start", required: true },
  ],

  async execute(args) {
    const record = requireProcess(args);
    const output = drain(record);
    const status = `${record.id} (${record.command}) — ${describe(record)}`;

    // An empty read is a real answer and has to say so: a server that started
    // cleanly and is waiting for a request prints nothing, and a bare empty
    // string reads as a broken tool.
    if (output === "") {
      return `${status}\n\nNo new output since the last read.`;
    }

    return `${status}\n\n${output}`;
  },
};

export const processStopTool: Tool = {
  name: "process_stop",
  description:
    "Stops a background process and returns any output it had not yet shown. Use it as soon as a process is no longer needed — one left running holds its port and its files.",

  parameters: [
    { name: "id", description: "The id returned by process_start", required: true },
  ],

  async execute(args) {
    const record = requireProcess(args);
    const alreadyExited = record.exitCode !== null;

    if (!alreadyExited) {
      // The whole tree, not just the shell — see the note at the spawn.
      terminateProcessTree(record.proc, record.processGroup);
      // Bounded: a process that ignores the signal must not hold the turn.
      await Promise.race([record.proc.exited, Bun.sleep(2000)]);
    }

    processes.delete(record.id);

    const trailing = drain(record);
    const outcome = alreadyExited
      ? `${record.id} had already ${describe(record)}.`
      : `Stopped ${record.id} (${record.command}).`;

    return trailing === "" ? outcome : `${outcome}\n\n${trailing}`;
  },
};

/**
 * Ends every background process.
 *
 * For session exit, and for tests, which would otherwise leave a spawned
 * process behind and hang the runner waiting on its handles.
 */
export function stopAllProcesses(): void {
  for (const record of [...processes.values()]) {
    processes.delete(record.id);
    if (record.exitCode === null) {
      terminateProcessTree(record.proc, record.processGroup);
      record.proc.unref();
    }
  }
}

/** The ids alive right now. Exists for tests. */
export function trackedProcessIds(): string[] {
  return [...processes.keys()];
}
