/**
 * A live interpreter inside the sandbox.
 *
 * The same drivers `tools/replDrivers.ts` runs locally, started as a background
 * command with its stdin held open. E2B supports exactly this on one call —
 * `background: true` with `stdin: true` gives a handle with `sendStdin`, and
 * `onStdout` delivers what comes back — so the framed protocol
 * `tools/replSession.ts` already speaks needs nothing added to it.
 *
 * Three differences from the local transport, all forced:
 *
 * **The driver is written to a file, not passed as an argument.** E2B takes a
 * command *string*, and this source is a hundred lines of Python containing
 * quotes, backslashes and newlines; shell-quoting it into a string is a bug
 * farm with no upside. That is also why both drivers read their sentinel from
 * the last argument — from a file, node's `argv[1]` is the script path.
 *
 * **Output is pushed, not pulled.** The callbacks fire from the moment the
 * command starts, so chunks are queued and handed out as `read()` asks for
 * them. The same lesson as background processes: a sink attached later than the
 * first byte loses everything before it, and here the first byte can be the
 * first frame.
 *
 * **stderr is not read**, matching the local transport. Both drivers capture
 * everything an evaluation prints into their own buffer and write it to stdout
 * as part of the frame, so anything on stderr came from the interpreter itself
 * and would corrupt the framing if it were interleaved.
 */

import { randomUUID } from "node:crypto";
import { REPL_DRIVERS, ReplUnavailableError } from "../../tools/replDrivers";
import type { ReplLaunch, ReplTransport } from "./executor";
import { isStdinHandle, resultFrom, type E2BStdinHandleLike } from "./e2bResult";
import { REMOTE_WORKSPACE } from "./settings";
import {
  SandboxUnavailableError,
  withToolchainPath,
  type SandboxClient,
  type SandboxSession,
} from "./session";
import { describeForModel, emptyReport, type SyncReport } from "./sync";

/**
 * Chunks that arrived before anyone asked for them.
 *
 * One reader at a time, which is what `readFrame` does — it reads until it sees
 * a sentinel and never overlaps two reads of the same session.
 */
class ChunkQueue {
  #chunks: string[] = [];
  #waiting: ((chunk: string | null) => void) | null = null;
  #ended = false;

  push = (chunk: string): void => {
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting(chunk);
      return;
    }
    this.#chunks.push(chunk);
  };

  /** The interpreter is gone; every read from here answers null. */
  end = (): void => {
    this.#ended = true;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting(null);
    }
  };

  next(): Promise<string | null> {
    const chunk = this.#chunks.shift();
    if (chunk !== undefined) return Promise.resolve(chunk);
    // Anything already queued is handed over before the end is reported, so a
    // driver that printed its last frame and exited is read out in full.
    if (this.#ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.#waiting = resolve;
    });
  }
}

/**
 * Finds an interpreter in the sandbox.
 *
 * `command -v` per candidate, first that resolves — the remote equivalent of
 * the `Bun.which` walk the local executor does, and for the same reason: the
 * message a model needs is "there is no python here", not whatever a shell says
 * when it cannot find one. One round trip per session, so once per language per
 * turn.
 */
async function resolveInterpreter(
  client: SandboxClient,
  language: ReplLaunch["language"],
): Promise<string> {
  const driver = REPL_DRIVERS[language];

  for (const candidate of driver.candidates) {
    const outcome = await client.commands
      .run(withToolchainPath(`command -v ${candidate}`), { cwd: REMOTE_WORKSPACE })
      .then(
        (value) => resultFrom(value),
        (error) => resultFrom(error),
      );

    if (outcome && outcome.exitCode === 0 && outcome.stdout.trim() !== "") {
      return outcome.stdout.trim().split("\n")[0]!;
    }
  }

  throw new ReplUnavailableError(
    `No ${language} interpreter is available in the sandbox ` +
      `(looked for ${driver.candidates.join(", ")}). Use run_terminal instead.`,
  );
}

class SandboxReplTransport implements ReplTransport {
  #session: SandboxSession;
  #client: SandboxClient;
  #handle: E2BStdinHandleLike;
  #queue: ChunkQueue;
  #report: SyncReport;

  constructor(
    session: SandboxSession,
    client: SandboxClient,
    handle: E2BStdinHandleLike,
    queue: ChunkQueue,
    report: SyncReport,
  ) {
    this.#session = session;
    this.#client = client;
    this.#handle = handle;
    this.#queue = queue;
    this.#report = report;
  }

  async write(line: string): Promise<void> {
    await this.#handle.sendStdin(line);
  }

  read(): Promise<string | null> {
    return this.#queue.next();
  }

  close(): void {
    // Synchronous and never throwing: `closeReplSessions` runs in the agent
    // loop's `finally` on every exit a turn has and can neither await nor
    // catch. Stdin first for the same reason as locally — both drivers loop
    // until their input ends, so closing it is what lets them finish normally —
    // and the kill is the backstop for one wedged inside an evaluation.
    try {
      void this.#handle
        .closeStdin()
        .catch(() => {})
        .finally(() => {
          void this.#client.commands.kill(this.#handle.pid).catch(() => {});
        });
    } catch {
      // The sandbox is already gone. There is nothing left to close.
    }
    this.#queue.end();
  }

  async beforeEval(): Promise<void> {
    // Local disk is authoritative for what goes in, exactly as for a command:
    // an evaluation reading a file the user edited a moment ago must see the
    // edit. `keepAlive` because a long turn of nothing but repl calls issues no
    // commands, and the lease is renewed per command.
    await this.#session.keepAlive();
    await this.#session.syncBefore(this.#report);
  }

  async afterEval(): Promise<string> {
    // A process can outlive its sandbox — `/sandbox off` disposes the session
    // while this transport is still in `replSession.ts`'s map. Going through
    // `syncAfter` then would reach `session.client()`, which *creates* one.
    // The same guard as a background process's `syncBack`.
    if (!this.#session.isRunning) {
      return (
        `\n\n[sandbox sync]\nThe sandbox was shut down, so anything this evaluation ` +
        `wrote is gone with it. Local files are unchanged.`
      );
    }

    try {
      await this.#session.syncAfter(this.#report);
    } catch (error) {
      return (
        `\n\n[sandbox sync]\nThe code ran, but its changes could not be brought back: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `Local files are unchanged.`
      );
    }

    return describeForModel(this.#report);
  }
}

export async function createSandboxReplTransport(
  session: SandboxSession,
  { language, sentinel }: ReplLaunch,
): Promise<ReplTransport> {
  const client = await session.client();
  await session.keepAlive();

  const driver = REPL_DRIVERS[language];
  const interpreter = await resolveInterpreter(client, language);

  // Outside the workspace, so it is never in a manifest and never syncs back as
  // a file the evaluation created.
  const driverPath = `/tmp/woopcode-repl-${randomUUID()}.${driver.extension}`;
  await client.files.write(driverPath, driver.source);

  const queue = new ChunkQueue();
  const report = emptyReport();

  const started = await client.commands.run(
    withToolchainPath(
      [interpreter, ...driver.leadingFlags, driverPath, sentinel].join(" "),
    ),
    {
      // The workspace, so a relative path in repl code means what it means
      // locally.
      cwd: REMOTE_WORKSPACE,
      background: true,
      stdin: true,
      // No timer: an interpreter is supposed to outlive the call that started
      // it. It ends at `closeReplSessions`, or with the sandbox.
      timeoutMs: 0,
      onStdout: queue.push,
    },
  );

  if (!isStdinHandle(started)) {
    throw new SandboxUnavailableError(
      "The sandbox did not return a writable handle for the interpreter.",
    );
  }

  // A driver that dies has to stop the reader waiting on it. Without this a
  // crashed interpreter hangs every evaluation until its timeout instead of
  // reporting that it exited.
  void started.wait().then(queue.end, queue.end);

  return new SandboxReplTransport(session, client, started, queue, report);
}
