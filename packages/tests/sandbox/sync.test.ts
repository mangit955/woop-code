import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  admissiblePaths,
  applyChanges,
  emptyReport,
  remoteManifest,
  MANIFEST_SENTINEL,
} from "../../../runtime/sandbox/sync";
import { buildManifest, diffManifests, parseSha256Sums } from "../../../runtime/sandbox/manifest";
import type { SandboxClient } from "../../../runtime/sandbox/session";

/**
 * Sync, against real files in a temp directory.
 *
 * No mocked filesystem: the whole question here is what ends up on disk when
 * two sides disagree, and a fake answer to that is not an answer. A UUID names
 * each workspace so parallel runs cannot collide.
 */

let workspace: string;
let staging: string;

async function write(root: string, relativePath: string, contents: string) {
  const full = path.join(root, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await Bun.write(full, contents);
}

async function read(root: string, relativePath: string): Promise<string | null> {
  const file = Bun.file(path.join(root, relativePath));
  return (await file.exists()) ? file.text() : null;
}

beforeEach(async () => {
  workspace = path.join(tmpdir(), `woopcode-sync-${crypto.randomUUID()}`);
  staging = path.join(tmpdir(), `woopcode-stage-${crypto.randomUUID()}`);
  await mkdir(workspace, { recursive: true });
  await mkdir(staging, { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
});

/** The manifest the command was handed. */
async function snapshotOf(files: string[]) {
  return buildManifest(workspace, files);
}

describe("the conflict rule", () => {
  test("unchanged locally, modified in the sandbox: the sandbox wins", async () => {
    await write(workspace, "foo.ts", "A");
    const snapshot = await snapshotOf(["foo.ts"]);
    await write(staging, "foo.ts", "B");

    const report = emptyReport();
    await applyChanges(workspace, staging, snapshot, ["foo.ts"], [], report);

    expect(await read(workspace, "foo.ts")).toBe("B");
    expect(report.written).toEqual(["foo.ts"]);
    expect(report.conflicts).toEqual([]);
  });

  test("unchanged locally, deleted in the sandbox: it is deleted", async () => {
    await write(workspace, "gone.ts", "A");
    const snapshot = await snapshotOf(["gone.ts"]);

    const report = emptyReport();
    await applyChanges(workspace, staging, snapshot, [], ["gone.ts"], report);

    expect(await read(workspace, "gone.ts")).toBeNull();
    expect(report.deleted).toEqual(["gone.ts"]);
  });

  test("changed locally and in the sandbox: the user's edit survives", async () => {
    // The case that motivated the whole design. Snapshot A went to the sandbox,
    // the user edited to C while it ran, the command produced D. Nothing is
    // merged and nothing the user typed is lost.
    await write(workspace, "foo.ts", "A");
    const snapshot = await snapshotOf(["foo.ts"]);

    await write(workspace, "foo.ts", "C");
    await write(staging, "foo.ts", "D");

    const report = emptyReport();
    await applyChanges(workspace, staging, snapshot, ["foo.ts"], [], report);

    expect(await read(workspace, "foo.ts")).toBe("C");
    expect(await read(workspace, "foo.ts.sandbox")).toBe("D");
    expect(report.conflicts).toEqual([
      { path: "foo.ts", savedAs: "foo.ts.sandbox", kind: "modified" },
    ]);
    expect(report.written).toEqual([]);
  });

  test("changed locally, deleted in the sandbox: nothing is deleted", async () => {
    await write(workspace, "foo.ts", "A");
    const snapshot = await snapshotOf(["foo.ts"]);
    await write(workspace, "foo.ts", "C");

    const report = emptyReport();
    await applyChanges(workspace, staging, snapshot, [], ["foo.ts"], report);

    expect(await read(workspace, "foo.ts")).toBe("C");
    expect(report.conflicts).toEqual([{ path: "foo.ts", kind: "deleted" }]);
    expect(report.deleted).toEqual([]);
  });

  test("a file the command created is written", async () => {
    const snapshot = await snapshotOf([]);
    await write(staging, "new.ts", "fresh");

    const report = emptyReport();
    await applyChanges(workspace, staging, snapshot, ["new.ts"], [], report);

    expect(await read(workspace, "new.ts")).toBe("fresh");
  });

  test("a file created in both places is a conflict, not an overwrite", async () => {
    // No snapshot entry, but something is there locally — the user created it
    // while the command ran. Their copy is not the sandbox's to replace.
    const snapshot = await snapshotOf([]);
    await write(workspace, "new.ts", "mine");
    await write(staging, "new.ts", "theirs");

    const report = emptyReport();
    await applyChanges(workspace, staging, snapshot, ["new.ts"], [], report);

    expect(await read(workspace, "new.ts")).toBe("mine");
    expect(await read(workspace, "new.ts.sandbox")).toBe("theirs");
  });

  test("nested paths are created as needed", async () => {
    const snapshot = await snapshotOf([]);
    await write(staging, "src/deep/nested.ts", "x");

    const report = emptyReport();
    await applyChanges(workspace, staging, snapshot, ["src/deep/nested.ts"], [], report);

    expect(await read(workspace, "src/deep/nested.ts")).toBe("x");
  });
});

describe("manifests", () => {
  test("new content under an old timestamp is still detected", async () => {
    // Why nothing here consults stat. `cp -p`, `tar -x`, `touch -d` and a
    // restored backup all write new content and put the old mtime back — and
    // "one"/"two" are the same length, so size cannot tell them apart either.
    // Any filter keyed on the pair would carry the stale hash forward and the
    // change would never be pushed.
    await write(workspace, "a.ts", "one");
    const before = await snapshotOf(["a.ts"]);

    const stat = await Bun.file(path.join(workspace, "a.ts")).stat();
    await write(workspace, "a.ts", "two");
    await utimes(path.join(workspace, "a.ts"), stat.atime, stat.mtime);

    const after = await buildManifest(workspace, ["a.ts"]);

    expect(diffManifests(before, after).changed).toEqual(["a.ts"]);
  });

  test("diff direction: before is what was believed, after is what is true", async () => {
    await write(workspace, "kept.ts", "same");
    await write(workspace, "gone.ts", "x");
    const before = await snapshotOf(["kept.ts", "gone.ts"]);

    await rm(path.join(workspace, "gone.ts"));
    await write(workspace, "added.ts", "y");
    const after = await buildManifest(workspace, ["kept.ts", "added.ts"]);

    const diff = diffManifests(before, after);
    expect(diff.changed).toEqual(["added.ts"]);
    expect(diff.deleted).toEqual(["gone.ts"]);
  });

  test("sha256sum output with spaces in the path is parsed whole", async () => {
    const hash = "a".repeat(64);
    const manifest = parseSha256Sums(`${hash}  ./src/a file with spaces.ts\n`);

    expect([...manifest.keys()]).toEqual(["src/a file with spaces.ts"]);
  });
});

describe("an unusable remote listing is never read as mass deletion", () => {
  function clientReturning(stdout: string): SandboxClient {
    return {
      sandboxId: "sbx",
      commands: {
        async run() {
          return { exitCode: 0, stdout, stderr: "" };
        },
        async kill() {
          return true;
        },
      },
      files: {
        async write() {
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
    };
  }

  test("a listing without the sentinel is null, not empty", async () => {
    // The most dangerous confusion available here: an empty manifest is
    // indistinguishable from "the command deleted everything", and the caller
    // acts on that by removing files from a working tree.
    expect(await remoteManifest(clientReturning(""))).toBeNull();
    expect(await remoteManifest(clientReturning("truncated outp"))).toBeNull();
  });

  test("a genuinely empty workspace still reports, and reports empty", async () => {
    const manifest = await remoteManifest(clientReturning(`${MANIFEST_SENTINEL}\n`));

    expect(manifest).not.toBeNull();
    expect(manifest!.size).toBe(0);
  });

  test("a populated listing parses", async () => {
    const hash = "b".repeat(64);
    const manifest = await remoteManifest(
      clientReturning(`${hash}  ./src/a.ts\n${MANIFEST_SENTINEL}\n`),
    );

    expect(manifest!.get("src/a.ts")?.hash).toBe(hash);
  });
});

describe("what may be written back", () => {
  test("a credential the sandbox produced is refused", async () => {
    // Otherwise a command could plant a .env in the working tree, and the
    // sandbox would have become a way to write credentials rather than to
    // contain them.
    const report = emptyReport();
    const admitted = await admissiblePaths(workspace, [".env", "src/a.ts", "deploy/id_rsa"], report);

    expect(admitted).toEqual(["src/a.ts"]);
    expect(report.refused.map((entry) => entry.reason)).toEqual(["secret", "secret"]);
  });

  test("a path escaping the workspace is refused", async () => {
    // Deliberately not a secret-shaped path: `../../.ssh/authorized_keys` is
    // caught by the credential rule first, which would make this pass without
    // the boundary check existing at all.
    const report = emptyReport();
    const admitted = await admissiblePaths(
      workspace,
      ["../../etc/passwd", "../sibling.ts", "ok.ts"],
      report,
    );

    expect(admitted).toEqual(["ok.ts"]);
    expect(report.refused.map((entry) => entry.reason)).toEqual([
      "outside-workspace",
      "outside-workspace",
    ]);
  });

  test("the boundary is judged against the synced tree, not the process directory", async () => {
    // These tests run from the repository, so a check bound to `process.cwd()`
    // would judge every candidate against the wrong root and quietly admit
    // paths that escape the workspace actually being synced.
    const report = emptyReport();
    const escape = path.relative(workspace, path.join(process.cwd(), "package.json"));

    const admitted = await admissiblePaths(workspace, [escape], report);

    expect(admitted).toEqual([]);
    expect(report.refused[0]?.reason).toBe("outside-workspace");
  });

  test("AppleDouble sidecars are never delivered", async () => {
    // macOS tar writes a `._name` member for every file with an extended
    // attribute; GNU tar in the sandbox extracts them as ordinary files, and
    // they then look exactly like files a command created. Measured: one run
    // put 217 of them in this repository before this rule existed.
    const report = emptyReport();
    const admitted = await admissiblePaths(
      workspace,
      ["._package.json", "src/._a.ts", "src/a.ts"],
      report,
    );

    expect(admitted).toEqual(["src/a.ts"]);
  });

  test("the file cap stops rather than truncating silently", async () => {
    const many = Array.from({ length: 600 }, (_, index) => `file-${index}.ts`);
    const report = emptyReport();
    const admitted = await admissiblePaths(workspace, many, report);

    expect(admitted).toHaveLength(500);
    expect(report.refused.filter((entry) => entry.reason === "over-file-cap")).toHaveLength(100);
  });
});
