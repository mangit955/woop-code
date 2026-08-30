import { describe, test, expect } from "bun:test";
import { classifyCommand, commandOf } from "../../../runtime/toolEffects";
import { blockedInPlanMode } from "../../../runtime/planMode";

/** A `run_terminal` command captured verbatim from a benchmark trial log. */
async function trialCommand(name: string): Promise<string> {
  return await Bun.file(
    new URL(`../fixtures/inline-scripts/${name}.sh`, import.meta.url),
  ).text();
}

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

/**
 * Inline scripts, which plan mode's second gate rests on.
 *
 * `run_terminal` stays available while planning, so an interpreter invoked with
 * `-c`/`-e` is the way a write reaches disk with the writing tools withheld. The
 * whole script sits inside one quoted run, so nothing below is visible to the
 * segment rules — these patterns are the only thing looking at it.
 */
describe("inline scripts that change files", () => {
  test.each([
    // Perl's idiom is a redirect inside the mode string, not a `w`.
    ["perl two-arg open for writing", `perl -e 'open(OUT, ">input.tex"); print OUT $t;'`],
    ["perl two-arg open for appending", `perl -e 'open(LOG, ">>run.log"); print LOG $t;'`],
    ["perl three-arg open", `perl -e 'open(my $fh, ">", $file) or die;'`],
    ["ruby File.write", `ruby -e 'File.write("out.txt", data)'`],
    // Shelling out builds its argument at runtime, so there is nothing to read.
    ["perl system", `perl -e 'system("pdflatex main.tex > /dev/null 2>&1");'`],
    ["perl qx", `perl -e 'my $out = qx(make -j4);'`],
    ["python subprocess", `python3 -c "import subprocess; subprocess.run(['make'])"`],
    ["node child_process", `node -e "require('child_process').execSync('make')"`],
    ["python os.system", `python3 -c "import os; os.system('make')"`],
  ])("%s writes", (_label, command) => {
    expect(classifyCommand(command).writes).toBe(true);
  });

  test.each([
    // The `>` addition must not read a read-mode open as a write.
    ["perl open for reading", `perl -e 'open(F, "<synonyms.txt"); while (<F>) { print; }'`],
    ["ruby File.read", `ruby -e 'puts File.read("notes.txt")'`],
    ["a comparison", `node -e "if (width > 100) console.log('wide')"`],
    ["a right shift", `python3 -c "print(value >> 16)"`],
    // Backticks are why the shell-out test is a list of named calls rather than
    // anything that runs a program: a template literal is not a subshell.
    ["a template literal", "node -e 'console.log(`width ${w}`)'"],
    ["reading a file", `python3 -c "print(open('notes.txt').read())"`],
    // `system` qualified by something other than `os` is usually not a subshell.
    ["platform.system", `python3 -c "import platform; print(platform.system())"`],
    ["a method named system", `perl -e 'my $rc = $obj->system(1);'`],
    // qx/qy/qz/qw are a quaternion's components, so this is division.
    ["quaternion arithmetic", `python3 -c "print(qx / qw, qy/n)"`],
  ])("%s does not write", (_label, command) => {
    expect(classifyCommand(command).writes).toBe(false);
  });

  test("the perl script that got through, verbatim", async () => {
    // jobs/tb2-post-1.1/overfull-hbox__Jk3CkEc, call 30 of 58: thirteen scripts
    // of this shape rewrote input.tex through `open(OUT, ">input.tex")` and ran
    // pdflatex through `system(...)`. The classifier flagged none of them.
    const command = await trialCommand("perl-overfull-hbox");
    expect(classifyCommand(command).writes).toBe(true);
    expect(blockedInPlanMode("run_terminal", { command })).toBe(true);
  });

  test("its read-only sibling from the same trial still passes", async () => {
    // Call 27, three iterations earlier: the same parsing preamble, reading
    // both files and printing. Plan mode has to keep letting this through.
    const command = await trialCommand("perl-overfull-hbox-read");
    expect(classifyCommand(command).writes).toBe(false);
    expect(blockedInPlanMode("run_terminal", { command })).toBe(false);
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
