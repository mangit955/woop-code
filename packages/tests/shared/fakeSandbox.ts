/**
 * A sandbox that answers like E2B without being one.
 *
 * Shared because three files need the same thing and the interesting part is
 * fiddly: the repl only works if the fake plays the *driver's* side of the
 * protocol as well as the SDK's — a line of JSON arrives on stdin and a frame
 * ending in the session's sentinel has to come back out through `onStdout`.
 * Hand-rolled per file, that gets subtly different each time and the tests stop
 * meaning the same thing.
 *
 * It does not evaluate anything. What is being tested here is the transport:
 * that source reaches the interpreter, that frames come back, and that the
 * session is started and torn down where it should be. Real evaluation is
 * covered against real interpreters in `packages/tests/tools/`, and against a
 * real sandbox in `e2b.integration.test.ts`.
 */

import type { SandboxClient, SandboxRunOpts } from "../../../runtime/sandbox/session";

export interface FakeSandboxOptions {
  /** Which interpreters `command -v` finds. Defaults to python3 and node. */
  interpreters?: string[];
  /** What the fake driver prints for a given source. Defaults to echoing it. */
  onEval?: (source: string) => string;
  /** Thrown by `commands.kill`, to prove a teardown swallows it. */
  killThrows?: Error;
}

export interface FakeSandbox {
  client: SandboxClient;
  /** Every command string passed to `commands.run`, in order. */
  commands: string[];
  /** Paths written with `files.write`, and what went into them. */
  written: Map<string, string>;
  /** Source lines the interpreter was sent, already JSON-decoded. */
  evaluated: string[];
  killed: number[];
  stdinClosed: number[];
  /** Pushes a chunk straight into the running interpreter's stdout. */
  emit(chunk: string): void;
}

export function fakeSandboxClient(options: FakeSandboxOptions = {}): FakeSandbox {
  const interpreters = options.interpreters ?? ["python3", "python", "node", "bun"];
  const onEval = options.onEval ?? ((source: string) => source);

  const commands: string[] = [];
  const written = new Map<string, string>();
  const evaluated: string[] = [];
  const killed: number[] = [];
  const stdinClosed: number[] = [];

  let sink: ((data: string) => void) | undefined;
  let sentinel = "";
  let pid = 1000;

  const client: SandboxClient = {
    sandboxId: "sbx-fake",

    commands: {
      async run(command: string, opts?: SandboxRunOpts) {
        commands.push(command);

        // `command -v <name>`, the remote equivalent of Bun.which.
        const lookup = command.match(/command -v (\S+)/);
        if (lookup) {
          const name = lookup[1]!;
          return interpreters.includes(name)
            ? { exitCode: 0, stdout: `/usr/bin/${name}\n`, stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "" };
        }

        if (opts?.background && opts.stdin) {
          // The sentinel is the interpreter's last argument, which is where
          // both drivers read it from.
          sentinel = command.trim().split(/\s+/).at(-1) ?? "";
          sink = opts.onStdout;
          const mine = ++pid;

          return {
            pid: mine,
            // A live interpreter never finishes on its own.
            wait: () => new Promise(() => {}),
            async sendStdin(data: string) {
              for (const line of data.split("\n")) {
                if (line.trim() === "") continue;
                const source = JSON.parse(line) as string;
                evaluated.push(source);
                sink?.(`${onEval(source)}\n${sentinel}\n`);
              }
            },
            async closeStdin() {
              stdinClosed.push(mine);
            },
          };
        }

        return { pid: ++pid, wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
      },

      async kill(target: number) {
        if (options.killThrows) throw options.killThrows;
        killed.push(target);
        return true;
      },
    },

    files: {
      async write(path: string, data: string | ArrayBuffer) {
        written.set(path, typeof data === "string" ? data : "<binary>");
        return {};
      },
      async read() {
        return "";
      },
    },

    async setTimeout() {},
    async kill() {
      return true;
    },
    getHost(port: number) {
      return `${port}-sbx-fake.e2b.app`;
    },
  };

  return {
    client,
    commands,
    written,
    evaluated,
    killed,
    stdinClosed,
    emit(chunk: string) {
      sink?.(chunk);
    },
  };
}
