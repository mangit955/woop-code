/**
 * The sandbox a session's commands run in.
 *
 * Created on the first command rather than at startup: a conversation that only
 * reads files should not wait for a virtual machine to boot, or pay for one.
 * Everything E2B is reached through `SandboxClient` below, so the lifecycle can
 * be tested against a fake without a network or an account.
 */

import path from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import {
  BUN_INSTALL_COMMAND,
  BUN_PATH_PREFIX,
  REMOTE_WORKSPACE,
  TAR_ENV,
  type SandboxSettings,
} from "./settings";
import { describeSkipped, transmittableSet, type TransmittableSet } from "./transmittable";
import { buildManifest, diffManifests, type Manifest } from "./manifest";
import {
  admissiblePaths,
  applyChanges,
  fetchToStaging,
  pushChanges,
  remoteManifest,
  type SyncReport,
} from "./sync";

/**
 * The part of E2B's `Sandbox` this uses.
 *
 * Narrow on purpose. A fake in a test implements six methods rather than the
 * whole SDK, and the parts of the SDK that are not used cannot quietly become
 * dependencies.
 */
export interface SandboxClient {
  readonly sandboxId: string;
  commands: {
    run(command: string, opts?: SandboxRunOpts): Promise<unknown>;
    kill(pid: number): Promise<boolean>;
  };
  files: {
    write(remotePath: string, data: string | ArrayBuffer): Promise<unknown>;
    // `format: "bytes"` is what makes a batched pull possible: the changed files
    // come back as one gzipped archive rather than a round trip each.
    read(remotePath: string, opts?: { format?: "text" | "bytes" }): Promise<string | Uint8Array>;
  };
  setTimeout(timeoutMs: number): Promise<void>;
  kill(): Promise<boolean>;
  /**
   * The hostname a port inside the sandbox is published on, without a scheme.
   *
   * Synchronous in the SDK — it is string formatting over the sandbox id, not a
   * request — and it answers regardless of whether anything is listening.
   */
  getHost(port: number): string;
}

export interface SandboxRunOpts {
  cwd?: string;
  timeoutMs?: number;
  background?: boolean;
  envs?: Record<string, string>;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  /**
   * Keeps the command's stdin open, so the handle can be written to.
   *
   * What makes an interpreter possible: without it the driver reads EOF
   * immediately and exits before anything can be sent.
   */
  stdin?: boolean;
}

/**
 * A sandbox could not be reached.
 *
 * Its own type because the one thing that must never happen is falling back to
 * the host: a user who asked for isolation and silently did not get it is worse
 * off than one who never asked, because they believe it held. Every caller
 * turns this into a refusal, never into a local command.
 */
export class SandboxUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SandboxUnavailableError";
  }
}

export type CreateSandbox = (settings: SandboxSettings) => Promise<SandboxClient>;

export interface SandboxSessionOptions {
  settings: SandboxSettings;
  workspace: string;
  createSandbox: CreateSandbox;
  /** Progress for the user: creating, pushing, provisioning. */
  onStatus?: (message: string) => void;
}

export class SandboxSession {
  #options: SandboxSessionOptions;
  #client: SandboxClient | null = null;
  /** In flight, so two commands at once do not create two sandboxes. */
  #starting: Promise<SandboxClient> | null = null;
  #pushed: TransmittableSet | null = null;

  /** What the sandbox is believed to hold, as of the last sync. */
  #remote: Manifest = new Map();
  /** The tree handed to the command now running: the conflict rule's reference. */
  #snapshot: Manifest = new Map();

  constructor(options: SandboxSessionOptions) {
    this.#options = options;
  }

  get sandboxId(): string | null {
    return this.#client?.sandboxId ?? null;
  }

  get isRunning(): boolean {
    return this.#client !== null;
  }

  /** What was sent, for reporting. Null until the first command. */
  get pushedSet(): TransmittableSet | null {
    return this.#pushed;
  }

  /**
   * The client, creating and preparing one if this is the first call.
   *
   * The in-flight promise is shared rather than awaited per caller: two tools
   * running in the same turn would otherwise each create a sandbox, and the
   * second would silently orphan the first.
   */
  async client(): Promise<SandboxClient> {
    if (this.#client) return this.#client;
    if (this.#starting) return this.#starting;

    this.#starting = this.#startup().finally(() => {
      this.#starting = null;
    });

    return this.#starting;
  }

  async #startup(): Promise<SandboxClient> {
    const { settings, workspace, createSandbox, onStatus } = this.#options;

    onStatus?.("creating sandbox…");
    let client: SandboxClient;
    try {
      client = await createSandbox(settings);
    } catch (error) {
      throw new SandboxUnavailableError(
        `Could not create a sandbox: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    try {
      const set = await transmittableSet(workspace, {
        maxFileBytes: settings.maxFileBytes,
      });
      this.#pushed = set;

      onStatus?.(`uploading ${set.files.length} files…`);
      await this.#push(client, set);

      // Seeded from what was just sent, so the first command's sync has nothing
      // to do. Without this the whole tree would be diffed against an empty
      // manifest and pushed a second time.
      const manifest = await buildManifest(workspace, set.files);
      this.#remote = manifest;

      const skipped = describeSkipped(set);
      if (skipped) onStatus?.(skipped);

      await this.#provision(client, set, onStatus);
    } catch (error) {
      // A sandbox that exists but was never prepared is worse than none: it
      // bills and it holds a stale tree. Take it down before reporting.
      await client.kill().catch(() => {});
      if (error instanceof SandboxUnavailableError) throw error;
      throw new SandboxUnavailableError(
        `Could not prepare the sandbox: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    this.#client = client;
    return client;
  }

  /**
   * Sends the workspace as one tarball.
   *
   * One upload rather than a write per file: measured at 421 files, the round
   * trips dominate everything else. The file list goes through a temporary file
   * outside the workspace — writing it inside would add a file to the tree that
   * the next push then has to explain.
   */
  async #push(client: SandboxClient, set: TransmittableSet): Promise<void> {
    const stamp = `${Date.now()}-${crypto.randomUUID()}`;
    const listPath = path.join(tmpdir(), `woopcode-sandbox-${stamp}.list`);
    const tarPath = path.join(tmpdir(), `woopcode-sandbox-${stamp}.tar.gz`);

    try {
      await Bun.write(listPath, set.files.length > 0 ? set.files.join("\n") + "\n" : "");

      const tar = Bun.spawnSync({
        cmd: ["tar", "-czf", tarPath, "-T", listPath],
        cwd: this.#options.workspace,
        env: TAR_ENV,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (tar.exitCode !== 0) {
        throw new Error(`tar failed: ${new TextDecoder().decode(tar.stderr).trim()}`);
      }

      const remoteArchive = "/home/user/workspace.tar.gz";
      await client.files.write(remoteArchive, await Bun.file(tarPath).arrayBuffer());
      await client.commands.run(
        `mkdir -p ${REMOTE_WORKSPACE} && tar -xzf ${remoteArchive} -C ${REMOTE_WORKSPACE} && rm -f ${remoteArchive}`,
      );
    } finally {
      // Best-effort: a leftover in the temp directory is harmless, and failing
      // to clean it up must not fail the push that succeeded.
      await Bun.file(listPath).unlink().catch(() => {});
      await Bun.file(tarPath).unlink().catch(() => {});
    }
  }

  /**
   * Whatever the tree needs before a command can be expected to work.
   *
   * The default exists for one measured reason: E2B's base template has no bun,
   * so a repository whose suite is `bun test` cannot run it. Keyed on `bun.lock`
   * being in what was actually sent, so nothing else pays for it.
   */
  async #provision(
    client: SandboxClient,
    set: TransmittableSet,
    onStatus?: (message: string) => void,
  ): Promise<void> {
    const setup = this.#options.settings.setupCommand;

    if (setup) {
      onStatus?.("running sandbox setup…");
      await client.commands.run(setup, { cwd: REMOTE_WORKSPACE, timeoutMs: 300_000 });
      return;
    }

    const needsBun = set.files.some(
      (file) => file === "bun.lock" || file === "bun.lockb" || file.endsWith("/bun.lock"),
    );
    if (!needsBun) return;

    onStatus?.("provisioning bun…");
    await client.commands.run(BUN_INSTALL_COMMAND, {
      cwd: REMOTE_WORKSPACE,
      timeoutMs: 300_000,
    });
  }

  /**
   * Brings the sandbox up to date with local disk, and records what it was given.
   *
   * The snapshot recorded here is what makes the pull afterwards answerable: the
   * sandbox holds exactly this, so anything different afterwards is the
   * command's doing and nothing else's.
   */
  async syncBefore(report: SyncReport): Promise<void> {
    const client = await this.client();

    const local = await pushChanges(
      client,
      this.#options.workspace,
      this.#remote,
      this.#options.settings.maxFileBytes,
      report,
    );

    // Two copies rather than one shared map: the snapshot must stay the tree
    // the command was handed even as the remote view moves on.
    this.#snapshot = new Map(local);
    this.#remote = new Map(local);
  }

  /**
   * Brings back what the command wrote.
   *
   * Diffed against the snapshot rather than against anything time-based, so the
   * question is what this command did to the tree it was given.
   */
  async syncAfter(report: SyncReport): Promise<void> {
    const client = await this.client();

    const after = await remoteManifest(client);

    // Unusable rather than empty — see `remoteManifest`. Acting on it would
    // read as "the command deleted everything" and take the working tree with
    // it. The sandbox's believed state is left alone too, so the next push
    // re-establishes it rather than assuming this one held.
    if (after === null) {
      report.refused.push({ path: "*", reason: "manifest-unavailable" });
      return;
    }

    const { changed, deleted } = diffManifests(this.#snapshot, after);
    this.#remote = after;

    if (changed.length === 0 && deleted.length === 0) return;

    const admitted = await admissiblePaths(this.#options.workspace, changed, report);
    const admittedDeletes = await admissiblePaths(this.#options.workspace, deleted, report);

    // Anything the pull refused is forgotten rather than remembered as
    // something the sandbox has and local does not — which is what the next
    // push reads as "delete it there". A command that wrote itself a `.env` or
    // a log file gets to keep it for the rest of the session; refusing to
    // deliver a file is not a reason to destroy it.
    for (const entry of report.refused) this.#remote.delete(entry.path);

    let staging: string | null = null;
    if (admitted.length > 0) {
      staging = await fetchToStaging(client, admitted);
    }

    try {
      await applyChanges(
        this.#options.workspace,
        staging ?? "",
        this.#snapshot,
        admitted,
        admittedDeletes,
        report,
      );
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Pushes the expiry back before a command runs.
   *
   * Called per command rather than on a timer: a sandbox reaped between two
   * tool calls loses the whole session's state, and a timer that stops with the
   * event loop is exactly the thing that would let it happen quietly.
   */
  async keepAlive(): Promise<void> {
    if (!this.#client) return;
    // Never fatal on its own — the command that follows will report a dead
    // sandbox far more clearly than a failed extension does.
    await this.#client.setTimeout(this.#options.settings.timeoutMs).catch(() => {});
  }

  async dispose(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#pushed = null;
    if (!client) return;

    await client.kill().catch(() => {});
  }
}

/**
 * The command prefix that makes a provisioned toolchain findable.
 *
 * `commands.run` is not a login shell, so nothing in `.bashrc` applies and a
 * freshly installed bun is simply not on PATH. Prepending it costs nothing when
 * the directory does not exist.
 */
export function withToolchainPath(command: string): string {
  return `export PATH="${BUN_PATH_PREFIX}:$PATH"; ${command}`;
}
