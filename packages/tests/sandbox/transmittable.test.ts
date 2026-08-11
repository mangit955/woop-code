import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  describeSkipped,
  isSecretShaped,
  transmittableSet,
} from "../../../runtime/sandbox/transmittable";

/**
 * What is allowed to leave the machine.
 *
 * Against a real git repository in a temp directory rather than a mocked one:
 * the whole point of this module is that it defers to git's ignore rules, and a
 * fake `git ls-files` would be testing the fake. A UUID names the fixture so two
 * runs at once cannot delete each other's files.
 */

const fixture = path.join(tmpdir(), `woopcode-transmittable-${crypto.randomUUID()}`);

async function write(relativePath: string, contents: string) {
  const full = path.join(fixture, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await Bun.write(full, contents);
}

function git(...args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: fixture, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
  }
}

beforeAll(async () => {
  await mkdir(fixture, { recursive: true });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");

  await write(".gitignore", "ignored/\n*.log\nsecrets.txt\n");
  await write("src/index.ts", "export const x = 1;\n");
  await write("README.md", "# fixture\n");
  await write("ignored/build.js", "// generated\n");
  await write("noisy.log", "log line\n");
  await write("secrets.txt", "hunter2\n");

  // Committed on purpose: being tracked must not make a credential sendable.
  await write(".env", "WOOPCODE_API_KEY=sk-should-never-travel\n");
  await write("deploy/id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  await write("certs/server.pem", "-----BEGIN CERTIFICATE-----\n");
  await write(".npmrc", "//registry.npmjs.org/:_authToken=npm_secret\n");

  await write("assets/big.bin", "x".repeat(2_000_000));

  // A symlink beside its target, and an AppleDouble sidecar: both are listed by
  // git and neither may be sent.
  await write("real.ts", "export const real = 1;\n");
  await symlink("real.ts", path.join(fixture, "link.ts"));
  await write("._real.ts", "\x00\x05\x16\x07resource fork\n");

  // Ordinary add first, so the .gitignore entries stay untracked and genuinely
  // ignored.
  git("add", "-A");
  // Then force the credentials in. This is the case the denylist exists for:
  // `git ls-files -c` lists *tracked* files whatever .gitignore says, so a
  // force-added .env is listed by git and has to be excluded by name.
  git("add", "-f", ".env", "deploy/id_rsa", "certs/server.pem", ".npmrc");
  git("commit", "-qm", "fixture");
});

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe("transmittable set", () => {
  test("git's ignore rules are honoured", async () => {
    const set = await transmittableSet(fixture);

    expect(set.fromGit).toBe(true);
    expect(set.files).toContain("src/index.ts");
    expect(set.files).toContain("README.md");
    // Ignored by .gitignore, so git never lists them.
    expect(set.files).not.toContain("ignored/build.js");
    expect(set.files).not.toContain("noisy.log");
  });

  test("credential-shaped files are excluded even when force-added and tracked", async () => {
    // The defect this module exists for, in its hardest form. These four are
    // committed, so git lists them and `.gitignore` has nothing to say — being
    // tracked is not evidence that a private key should be copied elsewhere.
    const set = await transmittableSet(fixture);

    for (const secret of [".env", "deploy/id_rsa", "certs/server.pem", ".npmrc"]) {
      expect(set.files).not.toContain(secret);
      expect(set.skipped.some((entry) => entry.path === secret && entry.reason === "secret")).toBe(
        true,
      );
    }
  });

  test("no file in the set carries the api key that was planted", async () => {
    // Belt and braces on the rule above: assert on the content that must not
    // travel, not only on the filename that was supposed to be caught.
    const set = await transmittableSet(fixture);

    for (const file of set.files) {
      const contents = await Bun.file(path.join(fixture, file)).text();
      expect(contents).not.toContain("sk-should-never-travel");
      expect(contents).not.toContain("npm_secret");
    }
  });

  test("files over the size cap are excluded and reported", async () => {
    const set = await transmittableSet(fixture);

    expect(set.files).not.toContain("assets/big.bin");
    const large = set.skipped.find((entry) => entry.path === "assets/big.bin");
    expect(large?.reason).toBe("too-large");
    expect(large?.bytes).toBe(2_000_000);
  });

  test("the cap is adjustable", async () => {
    const set = await transmittableSet(fixture, { maxFileBytes: 4_000_000 });

    expect(set.files).toContain("assets/big.bin");
    // Raising the cap never re-admits a secret.
    expect(set.files).not.toContain(".env");
  });

  test("skipped files are described rather than silently dropped", async () => {
    const set = await transmittableSet(fixture);
    const description = describeSkipped(set);

    expect(description).toContain("credential-shaped");
    expect(description).toContain("size cap");
  });

  test("a symlink is not transmitted", async () => {
    // `find -type f` in a sandbox does not match a symlink, so one pushed from
    // here would be missing from every listing that came back — and "missing
    // from the sandbox" is how the sync recognises a deletion. Sending one
    // therefore ends with the user's file being deleted. This repository has
    // exactly such a symlink, and it was deleted that way once.
    const set = await transmittableSet(fixture);

    expect(set.files).toContain("real.ts");
    expect(set.files).not.toContain("link.ts");
  });

  test("AppleDouble sidecars are not transmitted", async () => {
    const set = await transmittableSet(fixture);
    expect(set.files).not.toContain("._real.ts");
  });

  test("a directory that is not a git repository still applies the rules", async () => {
    const plain = path.join(tmpdir(), `woopcode-nogit-${crypto.randomUUID()}`);
    await mkdir(plain, { recursive: true });
    await Bun.write(path.join(plain, "app.ts"), "export {};\n");
    await Bun.write(path.join(plain, ".env"), "SECRET=1\n");

    try {
      const set = await transmittableSet(plain);

      expect(set.fromGit).toBe(false);
      expect(set.files).toContain("app.ts");
      // The guarantee that matters does not depend on git being there.
      expect(set.files).not.toContain(".env");
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe("secret shapes", () => {
  test.each([
    ".env",
    ".env.production",
    "config/.env.local",
    "id_rsa",
    "deploy/id_ed25519",
    "server.pem",
    "private.key",
    ".npmrc",
    ".netrc",
    "aws/credentials",
    ".ssh/config",
  ])("%s is treated as a secret", (candidate) => {
    expect(isSecretShaped(candidate)).toBe(true);
  });

  test.each([
    "src/environment.ts",
    "docs/env-vars.md",
    "keyboard.ts",
    "src/keys.tsx",
    "envelope.json",
  ])("%s is not", (candidate) => {
    expect(isSecretShaped(candidate)).toBe(false);
  });
});
