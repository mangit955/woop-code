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
 *
 * With the sandbox on they run there instead, and two things follow. What such
 * a process writes comes back at `process_stop` rather than as it goes — though
 * in practice most of it arrives sooner, because the next `run_terminal` pulls
 * whatever the sandbox holds. And a process outliving the sandbox's lease would
 * be reaped mid-session, so reading and stopping renew it. Both are asked of the
 * handle, which knows where its process is; this file still never branches on
 * whether there is a sandbox at all.
 */

import type { Tool } from "../config/types";
import { requestCommandApproval } from "./approval";
import { currentExecutor, type ProcessHandle } from "../runtime/sandbox";
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
  /**
   * The running command, wherever it is running. Owns the exit code and the
   * killing; everything below is this module's own bookkeeping.
   */
  handle: ProcessHandle;
  /** Output not yet handed to `process_output`. */
  unread: string;
  /** Characters dropped from the front of `unread` to stay under the cap. */
  dropped: number;
  startedAt: number;
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

function collect(record: BackgroundProcess): void {
  record.handle.onOutput((chunk) => {
    record.unread += chunk;
    if (record.unread.length > MAX_BUFFERED_OUTPUT) {
      const excess = record.unread.length - MAX_BUFFERED_OUTPUT;
      record.unread = record.unread.slice(excess);
      record.dropped += excess;
    }
  });
}

function describe(record: BackgroundProcess): string {
  if (record.handle.exitCode !== null) return `exited with code ${record.handle.exitCode}`;
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
    {
      name: "port",
      description:
        "The port this command listens on, if it is a server. Give it to get back the URL to reach it at — which is not localhost when the sandbox is on.",
      required: false,
      type: "number",
    },
  ],

  async execute(args) {
    const command = args.command;
    if (typeof command !== "string" || command.trim() === "") {
      throw Error("command is required and must be a non-empty string");
    }

    // Validated before anything is started, so a bad port is a message rather
    // than a running server the model was told nothing useful about.
    let port: number | undefined;
    if (args.port !== undefined) {
      const value = typeof args.port === "string" ? Number(args.port) : args.port;
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > 65535
      ) {
        throw Error(`port must be a whole number between 1 and 65535, not ${String(args.port)}`);
      }
      port = value;
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
    // The executor decides where this runs and hands back a handle. Locally
    // that is a process in its own group, so stopping it stops what it started:
    // measured, a `python3 ... ; true` left its interpreter running after
    // process_stop returned, which is exactly the leak this tool prevents.
    const handle = await currentExecutor().start(command, cwd);

    const record: BackgroundProcess = {
      id,
      command,
      handle,
      unread: "",
      dropped: 0,
      startedAt: Date.now(),
    };
    processes.set(id, record);

    collect(record);

    // Asked of the executor rather than assembled here: sandboxed, the port is
    // published on a host only the sandbox can name, and a model told to try
    // localhost would get a connection refused and conclude its server failed
    // to start. Best-effort — a URL that could not be worked out must not undo
    // a process that did start.
    let reach = "";
    if (port !== undefined) {
      try {
        const url = await currentExecutor().urlForPort(port);
        reach = `\n\nOn port ${port} it should be reachable at ${url} once it is listening.`;
      } catch (error) {
        reach =
          `\n\nIt was started, but the URL for port ${port} could not be worked out: ` +
          `${error instanceof Error ? error.message : String(error)}`;
      }
    }

    // Nothing is waited for, so there is nothing to report but the handle. The
    // model is told what to call next, because a bare id reads as a dead end.
    return (
      `Started ${id}: ${command}\n\n` +
      `It is running in the background. Call process_output with id "${id}" to read ` +
      `what it has printed, and process_stop to end it. It is not waited for, so ` +
      `give it a moment before expecting output.${reach}`
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
    // Reading is the only sign of life a background process gives off, so it is
    // what tells a sandbox the session is still going. Absent locally, where
    // there is no lease to renew.
    record.handle.keepAlive?.();

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
    record.handle.keepAlive?.();
    const alreadyExited = record.handle.exitCode !== null;

    if (!alreadyExited) {
      // The whole tree, not just the shell — see the note at the start.
      record.handle.terminate();
      // Bounded: a process that ignores the signal must not hold the turn.
      await Promise.race([record.handle.exited, Bun.sleep(2000)]);
    }

    processes.delete(record.id);

    // After it is dead, so what comes back is what it finally wrote rather than
    // a half-written file it was still appending to. Absent locally, where it
    // has been writing to the real tree all along. Never throws.
    const synced = (await record.handle.syncBack?.()) ?? "";

    const trailing = drain(record);
    const outcome = alreadyExited
      ? `${record.id} had already ${describe(record)}.`
      : `Stopped ${record.id} (${record.command}).`;

    const body = trailing === "" ? outcome : `${outcome}\n\n${trailing}`;
    return `${body}${synced}`;
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
    if (record.handle.exitCode === null) {
      record.handle.terminate();
      record.handle.unref();
    }
  }
}

/** The ids alive right now. Exists for tests. */
export function trackedProcessIds(): string[] {
  return [...processes.keys()];
}
