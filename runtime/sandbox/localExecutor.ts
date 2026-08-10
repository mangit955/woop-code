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
import type { Executor, ProcessHandle } from "./executor";

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
};
