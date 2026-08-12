/**
 * Running a command on this machine — what Woopcode has always done.
 *
 * A wrapper and nothing more. `runCommand`, `shellArgv` and
 * `terminateProcessTree` in `tools/command.ts` keep every detail they had: the
 * shell resolution, the process group, the descendant walk, the bounded waits.
 * All of that was written against failures that actually happened, and moving
 * it would be rewriting it. It moves *behind* an interface, not into one.
 */

import { runCommand, shellArgv, terminateProcessTree } from "../../tools/command";
import type { CommandResult } from "../../tools/command";
import { REPL_DRIVERS, ReplUnavailableError } from "../../tools/replDrivers";
import type { Executor, ProcessHandle, ReplLaunch, ReplTransport } from "./executor";

/**
 * Pumps a stream into a sink until it ends.
 *
 * Its own decoder per stream: `TextDecoder` with `{ stream: true }` carries the
 * tail of a partial multi-byte character between reads, so one decoder shared
 * across stdout and stderr would splice half a character from one stream onto
 * half of another.
 */
function pump(stream: ReadableStream<Uint8Array> | null, sink: (chunk: string) => void): void {
  if (!stream) return;

  void (async () => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sink(decoder.decode(value, { stream: true }));
      }
    } catch {
      // The process was killed mid-read, which is a normal end for this.
    }
  })();
}

class LocalProcessHandle implements ProcessHandle {
  #proc: ReturnType<typeof Bun.spawn>;
  #processGroup: boolean;
  #exitCode: number | null = null;

  constructor(proc: ReturnType<typeof Bun.spawn>, processGroup: boolean) {
    this.#proc = proc;
    this.#processGroup = processGroup;
    // Captured when it settles rather than read from `proc.exitCode`, which
    // stays null for a process killed by a signal.
    void proc.exited.then((code) => {
      this.#exitCode = code;
    });
  }

  get exitCode(): number | null {
    return this.#exitCode;
  }

  get exited(): Promise<number | null> {
    return this.#proc.exited;
  }

  onOutput(sink: (chunk: string) => void): void {
    pump(this.#proc.stdout as ReadableStream<Uint8Array> | null, sink);
    pump(this.#proc.stderr as ReadableStream<Uint8Array> | null, sink);
  }

  terminate(): void {
    terminateProcessTree(this.#proc, this.#processGroup);
  }

  unref(): void {
    this.#proc.unref();
  }
}

/**
 * All three streams piped, stated rather than inferred.
 *
 * `ReturnType<typeof Bun.spawn>` is the shape for the *default* options, where
 * stdin is ignored — so a session typed that way has a `stdin` of `number` and
 * no `write` on it, which is the opposite of what this needs.
 */
type PipedProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

/**
 * The pipe to an interpreter running on this machine.
 *
 * The stream is consumed through its async iterator rather than a reader.
 * Bun's `ReadableStreamDefaultReader.read` takes a buffer to fill, so the
 * zero-argument DOM form does not type-check against it. The iterator hands
 * back the chunk instead, which is all this needs, and it is still one held
 * cursor across many evaluations — the property that matters, since a reader
 * acquired per call would drop whatever had already been buffered.
 *
 * One `TextDecoder` for the life of the session, not one per read: with
 * `{ stream: true }` it carries the tail of a partial multi-byte character
 * between calls, and a decoder that only lives for one evaluation mangles any
 * character unlucky enough to straddle two.
 */
class LocalReplTransport implements ReplTransport {
  #proc: PipedProcess;
  #cursor: AsyncIterator<Uint8Array>;
  #decoder = new TextDecoder();

  constructor(proc: PipedProcess) {
    this.#proc = proc;
    this.#cursor = proc.stdout[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
  }

  async write(line: string): Promise<void> {
    this.#proc.stdin.write(line);
    this.#proc.stdin.flush();
  }

  async read(): Promise<string | null> {
    const chunk = await this.#cursor.next();
    if (chunk.done) return null;
    return this.#decoder.decode(chunk.value as Uint8Array, { stream: true });
  }

  /**
   * stdin is closed before the kill, and that ordering is the whole of it. Both
   * drivers loop until their input ends, so closing stdin is what lets them
   * return normally; `kill` alone left the pipe open, and Bun kept the process
   * handle alive waiting on a writer that never went away — a probe that had
   * already printed every result sat for two minutes before exiting. The kill
   * stays as the backstop for a driver wedged inside an evaluation, which will
   * never reach its read of stdin to notice the close.
   */
  close(): void {
    this.#cursor.return?.(undefined)?.catch(() => {
      // The process is being killed regardless; a cursor that will not release
      // is not a reason to leave the interpreter running.
    });

    try {
      this.#proc.stdin.end();
    } catch {
      // Already closed, or the process is gone. The kill below covers both.
    }

    this.#proc.kill();
    this.#proc.unref();
  }
}

export const localExecutor: Executor = {
  kind: "local",

  run(
    command: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
    cwd?: string,
  ): Promise<CommandResult> {
    return runCommand(command, timeoutSeconds, signal, cwd);
  },

  async start(command: string, cwd?: string): Promise<ProcessHandle> {
    // Its own process group where the platform allows it, so stopping the
    // command stops what it started. See the note in `tools/command.ts`.
    const { cmd, processGroup } = shellArgv(command);
    const proc = Bun.spawn({
      cmd,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    return new LocalProcessHandle(proc, processGroup);
  },

  // Nothing to map: the port is on this machine. `localhost` rather than
  // `127.0.0.1` because a server bound to the IPv6 loopback is reachable by the
  // name and not by the v4 address.
  async urlForPort(port: number): Promise<string> {
    return `http://localhost:${port}`;
  },

  async startRepl({ language, sentinel }: ReplLaunch): Promise<ReplTransport> {
    const driver = REPL_DRIVERS[language];
    const interpreter = driver.candidates
      .map((candidate) => Bun.which(candidate))
      .find((resolved): resolved is string => resolved !== null);

    if (!interpreter) {
      throw new ReplUnavailableError(
        `No ${language} interpreter is available on this machine ` +
          `(looked for ${driver.candidates.join(", ")}). Use run_terminal instead.`,
      );
    }

    // Passed inline rather than written to a file: nothing about this machine
    // makes a temporary file necessary, and one more path is one more thing to
    // clean up. The sandbox cannot do this, which is why the driver reads its
    // sentinel from the last argument rather than a fixed position.
    const proc: PipedProcess = Bun.spawn({
      cmd: [interpreter, ...driver.leadingFlags, driver.inlineFlag, driver.source, sentinel],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    return new LocalReplTransport(proc);
  },
};
