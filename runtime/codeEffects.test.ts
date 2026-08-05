import { describe, test, expect } from "bun:test";
import { classifyCode, classifyInvocation, codeShellsOut } from "./toolEffects";
import { blockedInPlanMode } from "./planMode";

/**
 * The REPL's half of plan mode's second gate.
 *
 * Both directions everywhere, for the reason `planMode.test.ts` states: a gate
 * tested only on what it blocks passes just as well when it blocks everything.
 *
 * The refusals here are the ones that matter. `repl` carries its source in a
 * `code` argument, which `commandOf` does not read and `classifyCommand`'s
 * inline-script pattern does not match — so before `classifyInvocation` existed
 * a REPL call opening a file for writing was not seen by the gate at all, and
 * plan mode allowed it through while reporting nothing had changed.
 */

describe("classifyCode — what interpreter source does", () => {
  describe("writes", () => {
    test("a Python file opened for writing", () => {
      expect(classifyCode("open('notes.txt', 'w').write('x')").writes).toBe(true);
    });

    test("a Python file opened for appending", () => {
      expect(classifyCode("f = open('log.txt', 'a')").writes).toBe(true);
    });

    test("pathlib's write_text", () => {
      expect(classifyCode("Path('out.txt').write_text('x')").writes).toBe(true);
    });

    test("os.remove and friends", () => {
      expect(classifyCode("os.remove('gone.txt')").writes).toBe(true);
      expect(classifyCode("os.makedirs('a/b')").writes).toBe(true);
      expect(classifyCode("shutil.move('a', 'b')").writes).toBe(true);
    });

    test("Node's writeFileSync", () => {
      expect(classifyCode("fs.writeFileSync('out.js', src)").writes).toBe(true);
    });

    test("Bun.write", () => {
      expect(classifyCode("Bun.write('out.txt', data)").writes).toBe(true);
    });
  });

  describe("does not write", () => {
    test("a file opened for reading", () => {
      expect(classifyCode("data = open('input.txt').read()").writes).toBe(false);
    });

    test("readFileSync", () => {
      expect(classifyCode("const src = fs.readFileSync('vm.js', 'utf8')").writes).toBe(false);
    });

    test("arithmetic that shifts right", () => {
      // The reason this file exists. Under the shell rules `>>` is a redirect
      // and this reads as writing to a file called `16` — and the benchmark
      // trials are full of exactly this, walking ELF headers and packing ints.
      expect(classifyCode("value = 0x4395e4 >> 16").writes).toBe(false);
    });

    test("a comparison", () => {
      expect(classifyCode("if width > 100: print('wide')").writes).toBe(false);
    });

    test("statements separated by semicolons", () => {
      // `;` is a segment separator to the shell classifier, and `rm` at the
      // head of a segment is a writing command — but here it is a variable.
      expect(classifyCode("rm = 5; total = rm * 2").writes).toBe(false);
    });

    test("a bitwise or", () => {
      expect(classifyCode("flags = a | b").writes).toBe(false);
    });

    test("printing to stdout", () => {
      expect(classifyCode("print('hello')").writes).toBe(false);
      expect(classifyCode("process.stdout.write('hi')").writes).toBe(false);
    });

    test("empty source", () => {
      expect(classifyCode("")).toEqual({ writes: false, verifies: false });
      expect(classifyCode("   ")).toEqual({ writes: false, verifies: false });
    });
  });

  describe("shelling out is treated as writing", () => {
    test.each([
      ["subprocess.run(['make'])", "subprocess"],
      ["os.system('make')", "os.system"],
      ["execSync('make')", "execSync"],
      ["require('child_process').spawn('sh')", "child_process"],
    ])("%s", (code) => {
      // Its argument is built at runtime, so there is nothing here to read.
      // Unrecognised means destructive, as everywhere else in this codebase.
      expect(codeShellsOut(code)).toBe(true);
      expect(classifyCode(code).writes).toBe(true);
    });

    test("ordinary source does not", () => {
      expect(codeShellsOut("total = sum(values)")).toBe(false);
    });
  });

  describe("verifies", () => {
    test("an assertion counts as a check", () => {
      expect(classifyCode("assert total == 42").verifies).toBe(true);
    });

    test("arithmetic does not", () => {
      expect(classifyCode("total = 1 + 1").verifies).toBe(false);
    });
  });
});

describe("classifyInvocation — one entry point for both shapes", () => {
  test("reads a code argument as source", () => {
    expect(classifyInvocation({ code: "value >> 16" }).writes).toBe(false);
    expect(classifyInvocation({ code: "open('f','w')" }).writes).toBe(true);
  });

  test("reads a command argument as a shell line", () => {
    expect(classifyInvocation({ command: "sed -i s/a/b/ f.c" }).writes).toBe(true);
    expect(classifyInvocation({ command: "grep -r foo ." }).writes).toBe(false);
  });

  test("an argumentless call changes nothing", () => {
    expect(classifyInvocation({})).toEqual({ writes: false, verifies: false });
  });
});

describe("plan mode gates a repl call on its source", () => {
  test("refuses source that writes a file", () => {
    expect(blockedInPlanMode("repl", { language: "python", code: "open('x','w')" })).toBe(
      true,
    );
  });

  test("refuses source that shells out", () => {
    expect(
      blockedInPlanMode("repl", { language: "python", code: "subprocess.run(['rm','x'])" }),
    ).toBe(true);
  });

  test("allows source that only reads and computes", () => {
    // The permission half. Inspection is most of what planning is, and a REPL
    // that could not be used to look at anything would be withheld in the one
    // mode it is most useful in.
    expect(
      blockedInPlanMode("repl", {
        language: "python",
        code: "data = open('gates.txt').read()\nlen(data)",
      }),
    ).toBe(false);
  });

  test("allows arithmetic containing a right shift", () => {
    expect(blockedInPlanMode("repl", { language: "node", code: "v >> 16" })).toBe(false);
  });

  test("still refuses a run_terminal write", () => {
    expect(blockedInPlanMode("run_terminal", { command: "cat > f.txt" })).toBe(true);
  });
});

describe("plan mode and the background process tools", () => {
  test("refuses starting a command that writes", () => {
    expect(blockedInPlanMode("process_start", { command: "rm -rf build" })).toBe(true);
  });

  test("allows starting a server", () => {
    expect(blockedInPlanMode("process_start", { command: "python3 -m http.server" })).toBe(
      false,
    );
  });

  test("allows reading and stopping, which change nothing", () => {
    expect(blockedInPlanMode("process_output", { id: "bg1" })).toBe(false);
    expect(blockedInPlanMode("process_stop", { id: "bg1" })).toBe(false);
  });
});

describe("plan mode and read_image", () => {
  test("allows it — looking at a file changes nothing", () => {
    expect(blockedInPlanMode("read_image", { path: "shot.png" })).toBe(false);
  });
});
