import { describe, test, expect } from "bun:test";
import { classifyCommand, commandOf } from "../../../runtime/toolEffects";

describe("commands that change files", () => {
  // Taken verbatim from a benchmark run, where the agent used the file tools
  // four times in 388 iterations and did its real editing through the shell.
  test.each([
    ["append heredoc", "cd /app/source && cat >> unix.c << 'EOF'\nint pov_rand(void);\nEOF"],
    ["in-place sed", "cd /app/source && sed -i 's/CC =.*/CC = gcc/' unix.mak"],
    ["printf redirect", "printf '\\nint pov_rand(void);\\n' > /app/source/rand.c"],
    ["tee", "echo 'CFLAGS=-O2' | tee -a Makefile"],
    ["perl in-place", "perl -i -pe 's/foo/bar/' config.h"],
    ["python write", "python3 -c \"open('out.txt','w').write('x')\""],
    ["move", "mv build/sim /app/sim"],
    ["remove", "rm -rf build/cache"],
    ["patch", "patch -p1 < fix.diff"],
    ["git checkout", "git checkout -- src/main.c"],
  ])("%s writes", (_label, command) => {
    expect(classifyCommand(command).writes).toBe(true);
  });

  test.each([
    ["listing", "ls -la /app/source"],
    ["reading", "cat unix.c"],
    ["grep", "grep -rn 'pov_rand' src/"],
    ["inspect", "readelf -h /app/sim"],
    ["stderr redirect", "./configure 2>&1"],
    ["pipe to pager", "git log | head -20"],
  ])("%s does not write", (_label, command) => {
    expect(classifyCommand(command).writes).toBe(false);
  });

  test("redirecting to stderr is not a file write", () => {
    // `2>&1` and `>&2` are the common false positives for a naive `>` match.
    expect(classifyCommand("make 2>&1 >&2").writes).toBe(false);
  });
});

describe("commands that verify", () => {
  test.each([
    ["bun test", "bun test packages/tests"],
    ["pytest", "python3 -m pytest -q"],
    ["make", "cd /app && make"],
    ["typecheck", "bunx tsc --noEmit"],
    ["compile", "gcc -O2 -c unix.c"],
    ["latex", "pdflatex main.tex"],
    ["cargo", "cargo check"],
    // A live turn ran exactly this to verify a fix and it went unrecognised,
    // so the turn was reported unverified after it had been verified.
    ["bun run a check script", "bun run check.ts"],
    ["npm run test script", "npm run test:unit"],
  ])("%s verifies", (_label, command) => {
    expect(classifyCommand(command).verifies).toBe(true);
  });

  test.each([
    ["listing", "ls -la"],
    ["reading", "cat README.md"],
    ["inspect", "readelf -h ./sim"],
    ["move", "mv a b"],
    // `run` alone is not a check: starting a server verifies nothing.
    ["bun run a server", "bun run server.ts"],
    ["npm start", "npm run start"],
  ])("%s does not verify", (_label, command) => {
    // Treating every shell command as verification is what made the first
    // measurement of the verification gap meaningless.
    expect(classifyCommand(command).verifies).toBe(false);
  });
});

describe("commands that do both", () => {
  test("an edit followed by a build is recorded as both", () => {
    const effect = classifyCommand(
      "sed -i 's/-O/-O2/' unix.mak && make -j4",
    );
    expect(effect).toEqual({ writes: true, verifies: true });
  });

  test("an edit alone is not verification", () => {
    expect(classifyCommand("sed -i 's/a/b/' f.c")).toEqual({
      writes: true,
      verifies: false,
    });
  });
});

describe("finding the command in tool arguments", () => {
  test("reads the command argument", () => {
    expect(commandOf({ command: "bun test" })).toBe("bun test");
  });

  test("tolerates the alternative names a provider may emit", () => {
    expect(commandOf({ cmd: "ls" })).toBe("ls");
    expect(commandOf({ script: "make" })).toBe("make");
  });

  test("a call with no command yields nothing to classify", () => {
    expect(commandOf({ path: "a.ts" })).toBe("");
    expect(classifyCommand("")).toEqual({ writes: false, verifies: false });
  });
});
