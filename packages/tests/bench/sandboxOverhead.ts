/**
 * Phase 0 of the sandbox plan: what does routing a command through E2B cost?
 *
 * The plan's design pushes changed files before every command and pulls back
 * what the command wrote, which is only reasonable if that round trip is
 * measured in milliseconds. Nothing in the plan is built until this says so —
 * the "~200-600ms" figure it was sketched with was an estimate, not a number.
 *
 * Prototypes the real logic rather than a simplification, so the timings mean
 * something: the transmittable set is the one Phase 3 will use (git's ignore
 * rules plus the secret denylist), and the manifest is SHA-256 with stat as a
 * candidate filter, exactly as specified.
 *
 *   E2B_API_KEY=... bun packages/tests/bench/sandboxOverhead.ts
 *
 * Costs money: it creates a real sandbox and kills it at the end.
 */

import { Sandbox } from "e2b";
import path from "node:path";
import { stat } from "node:fs/promises";

const WORKSPACE = process.cwd();
const REMOTE_ROOT = "/home/user/workspace";

/**
 * Files that must never leave the machine, whatever the repository has chosen
 * to commit. `.gitignore` covers the usual case — this covers the repository
 * that committed its `.env` anyway.
 */
const SECRET_PATTERNS = [
  /(^|\/)\.env($|\.)/,
  /\.pem$/,
  /\.key$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)($|\.)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)credentials$/,
];

function isSecret(relativePath: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(relativePath));
}

/**
 * The set of files that may be transmitted to a sandbox.
 *
 * `git ls-files -co --exclude-standard` is tracked files plus untracked ones
 * that are not ignored — which is to say, git's own answer to "what in this
 * tree matters", including every .gitignore rule, nested ones included.
 * Reimplementing that matching would be a second copy of a spec git already
 * holds.
 */
async function transmittableSet(): Promise<{ files: string[]; excluded: string[] }> {
  const listed = Bun.spawnSync({
    cmd: ["git", "ls-files", "-co", "--exclude-standard"],
    cwd: WORKSPACE,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (listed.exitCode !== 0) {
    throw new Error(
      "not a git repository — the real implementation needs a walkWorkspace fallback here",
    );
  }

  const all = new TextDecoder()
    .decode(listed.stdout)
    .split("\n")
    .filter(Boolean);

  const files: string[] = [];
  const excluded: string[] = [];
  for (const file of all) {
    if (isSecret(file)) excluded.push(file);
    else files.push(file);
  }

  return { files, excluded };
}

interface Entry {
  hash: string;
  size: number;
  mtimeMs: number;
}

/** SHA-256 of a file's contents. Stat decides *whether* to call this. */
async function hashFile(absolutePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(absolutePath).arrayBuffer());
  return hasher.digest("hex");
}

/**
 * A full manifest: every transmittable file hashed. This is the cold cost,
 * paid once at session start.
 */
async function buildManifest(files: string[]): Promise<Map<string, Entry>> {
  const manifest = new Map<string, Entry>();

  const CONCURRENCY = 32;
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const file = files[cursor++]!;
      const absolute = path.join(WORKSPACE, file);
      try {
        const info = await stat(absolute);
        manifest.set(file, {
          hash: await hashFile(absolute),
          size: info.size,
          mtimeMs: info.mtimeMs,
        });
      } catch {
        // Raced with a delete; it is simply not in the manifest.
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return manifest;
}

/**
 * The warm cost, paid before every command: stat everything, hash only what
 * stat says might have changed. This is the number that decides whether
 * push-before-every-command is viable.
 */
async function refreshManifest(
  files: string[],
  previous: Map<string, Entry>,
): Promise<{ manifest: Map<string, Entry>; rehashed: number; changed: string[] }> {
  const manifest = new Map<string, Entry>();
  const changed: string[] = [];
  let rehashed = 0;

  const CONCURRENCY = 32;
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const file = files[cursor++]!;
      const absolute = path.join(WORKSPACE, file);
      try {
        const info = await stat(absolute);
        const before = previous.get(file);

        // Stat is a candidate filter and nothing more. Identical size and
        // mtime means "no need to read the file"; it never decides which
        // version of a file wins.
        if (before && before.size === info.size && before.mtimeMs === info.mtimeMs) {
          manifest.set(file, before);
          continue;
        }

        rehashed++;
        const hash = await hashFile(absolute);
        manifest.set(file, { hash, size: info.size, mtimeMs: info.mtimeMs });
        if (!before || before.hash !== hash) changed.push(file);
      } catch {
        // Deleted since the last pass.
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return { manifest, rehashed, changed };
}

function ms(start: number): number {
  return Math.round(performance.now() - start);
}

function report(label: string, value: number | string, note = "") {
  const shown = typeof value === "number" ? `${value}ms` : value;
  console.log(`  ${label.padEnd(42)} ${String(shown).padStart(10)}  ${note}`);
}

async function main() {
  if (!process.env.E2B_API_KEY) {
    console.error("E2B_API_KEY is not set. Nothing to measure.");
    process.exit(1);
  }

  console.log(`\nworkspace: ${WORKSPACE}\n`);

  // ---- local: what would be sent, and what it costs to know that ----
  console.log("local");

  let start = performance.now();
  const { files, excluded } = await transmittableSet();
  const enumerateMs = ms(start);

  let totalBytes = 0;
  for (const file of files) {
    try {
      totalBytes += (await stat(path.join(WORKSPACE, file))).size;
    } catch {}
  }

  report("enumerate transmittable set", enumerateMs, `${files.length} files, ${(totalBytes / 1_048_576).toFixed(1)}MB`);
  report("excluded as secret-shaped", excluded.length === 0 ? "none" : excluded.join(", "));

  start = performance.now();
  const manifest = await buildManifest(files);
  report("build full manifest (cold, hash all)", ms(start), `${manifest.size} hashed`);

  start = performance.now();
  const warm = await refreshManifest(files, manifest);
  report("refresh manifest (warm, no edits)", ms(start), `${warm.rehashed} rehashed`);

  // One real edit, to price the common case: agent writes a file, then runs a
  // command. Touch a scratch file rather than mutating anything real.
  const scratch = path.join(WORKSPACE, ".sandbox-bench-scratch.txt");
  await Bun.write(scratch, `edited ${Date.now()}\n`);
  const withScratch = [...files, ".sandbox-bench-scratch.txt"];
  start = performance.now();
  const afterEdit = await refreshManifest(withScratch, warm.manifest);
  report("refresh manifest (warm, 1 edit)", ms(start), `${afterEdit.rehashed} rehashed, ${afterEdit.changed.length} changed`);

  // ---- sandbox ----
  console.log("\nsandbox");

  start = performance.now();
  const sandbox = await Sandbox.create({ timeoutMs: 5 * 60_000 });
  report("Sandbox.create", ms(start), sandbox.sandboxId);

  try {
    // Initial push: one tarball, not N round trips.
    const listFile = path.join(WORKSPACE, ".sandbox-bench-filelist");
    await Bun.write(listFile, files.join("\n") + "\n");
    const tarPath = path.join(WORKSPACE, ".sandbox-bench.tar.gz");

    start = performance.now();
    const tar = Bun.spawnSync({
      cmd: ["tar", "-czf", tarPath, "-T", listFile],
      cwd: WORKSPACE,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (tar.exitCode !== 0) {
      throw new Error(`tar failed: ${new TextDecoder().decode(tar.stderr)}`);
    }
    const tarMs = ms(start);
    const tarBytes = (await stat(tarPath)).size;
    report("tar workspace", tarMs, `${(tarBytes / 1_048_576).toFixed(1)}MB compressed`);

    start = performance.now();
    // ArrayBuffer, not Uint8Array: `files.write` accepts string | Blob |
    // ArrayBuffer | ReadableStream, and a typed array is none of them.
    await sandbox.files.write(
      "/home/user/workspace.tar.gz",
      await Bun.file(tarPath).arrayBuffer(),
    );
    report("upload tarball", ms(start));

    start = performance.now();
    await sandbox.commands.run(
      `mkdir -p ${REMOTE_ROOT} && tar -xzf /home/user/workspace.tar.gz -C ${REMOTE_ROOT}`,
    );
    report("extract in sandbox", ms(start));

    // ---- per-command overhead ----
    console.log("\nper command");

    start = performance.now();
    await sandbox.commands.run("true", { cwd: REMOTE_ROOT });
    report("trivial command round trip", ms(start), "`true`");

    start = performance.now();
    await sandbox.commands.run("echo hello > /dev/null", { cwd: REMOTE_ROOT });
    report("trivial command round trip (2nd)", ms(start), "warm connection");

    // Incremental push of a single changed file.
    start = performance.now();
    await sandbox.files.write(
      `${REMOTE_ROOT}/.sandbox-bench-scratch.txt`,
      await Bun.file(scratch).text(),
    );
    report("push 1 changed file", ms(start));

    // Sandbox-side manifest: the pull's candidate filter plus hashing.
    await sandbox.commands.run(`touch /home/user/.stamp`, { cwd: REMOTE_ROOT });
    await sandbox.commands.run(`echo changed > ${REMOTE_ROOT}/written-by-command.txt`, {
      cwd: REMOTE_ROOT,
    });

    const manifestCmd =
      `cd ${REMOTE_ROOT} && find . -type f -newer /home/user/.stamp ` +
      `-not -path './.git/*' -not -path './node_modules/*' -print0 ` +
      `| xargs -0 -r sha256sum`;

    start = performance.now();
    const changedRemote = await sandbox.commands.run(manifestCmd, { cwd: REMOTE_ROOT });
    const remoteChanged = changedRemote.stdout.trim().split("\n").filter(Boolean);
    report("sandbox manifest (candidates only)", ms(start), `${remoteChanged.length} changed`);

    // Full-tree hash, for comparison: the cost if we did NOT filter first.
    const fullCmd =
      `cd ${REMOTE_ROOT} && find . -type f -not -path './.git/*' ` +
      `-not -path './node_modules/*' -print0 | xargs -0 -r sha256sum | wc -l`;
    start = performance.now();
    const full = await sandbox.commands.run(fullCmd, { cwd: REMOTE_ROOT });
    report("sandbox manifest (full tree hash)", ms(start), `${full.stdout.trim()} files`);

    start = performance.now();
    await sandbox.files.read(`${REMOTE_ROOT}/written-by-command.txt`);
    report("pull 1 changed file", ms(start));

    // ---- a real workload ----
    console.log("\nworkload");

    start = performance.now();
    const install = await sandbox.commands.run("cd " + REMOTE_ROOT + " && ls -1 | head -5", {
      cwd: REMOTE_ROOT,
    });
    report("ls (sanity: files arrived)", ms(start), install.stdout.trim().split("\n").join(" "));

    start = performance.now();
    const bunCheck = await sandbox.commands.run("which bun || echo MISSING", { cwd: REMOTE_ROOT });
    report("bun present in base template?", ms(start), bunCheck.stdout.trim());

    // ---- isolation spot checks, cheap to do while we are here ----
    console.log("\nisolation");

    const envLeak = await sandbox.commands.run(
      "env | grep -c -E 'WOOPCODE|ANTHROPIC|OPENAI|GEMINI|E2B' || true",
      { cwd: REMOTE_ROOT },
    );
    report("agent credentials visible in env", envLeak.stdout.trim(), "want 0");

    const dotenv = await sandbox.commands.run(`test -f ${REMOTE_ROOT}/.env && echo PRESENT || echo ABSENT`, {
      cwd: REMOTE_ROOT,
    });
    report(".env transmitted?", dotenv.stdout.trim(), "want ABSENT");

    const metadata = await sandbox.commands.run(
      "curl -s -m 3 -o /dev/null -w '%{http_code}' http://169.254.169.254/ || echo blocked",
      { cwd: REMOTE_ROOT },
    );
    report("cloud metadata endpoint", metadata.stdout.trim(), "want blocked/000");

    const internet = await sandbox.commands.run(
      "curl -s -m 5 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/ || echo failed",
      { cwd: REMOTE_ROOT },
    );
    report("npm registry reachable", internet.stdout.trim(), "want 200 (default egress on)");
  } finally {
    await sandbox.kill();
    console.log("\nsandbox killed");

    for (const leftover of [
      ".sandbox-bench-scratch.txt",
      ".sandbox-bench-filelist",
      ".sandbox-bench.tar.gz",
    ]) {
      try {
        Bun.spawnSync({ cmd: ["rm", "-f", path.join(WORKSPACE, leftover)] });
      } catch {}
    }
  }
}

await main();
