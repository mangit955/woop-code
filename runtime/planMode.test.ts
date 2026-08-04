import { describe, test, expect } from "bun:test";
import {
  blockedInPlanMode,
  nextSessionMode,
  planModeRefusal,
  planModeTools,
  sessionModeLabel,
} from "./planMode";
import { TOOL_EFFECTS, toolEffect } from "./toolEffects";
import { toolRegistery } from "../tools";
import type { Tool } from "../config/types";

/**
 * Both directions, for every case. A gate tested only on what it blocks passes
 * just as well when it blocks everything, which would make plan mode useless
 * rather than unsafe — and a gate tested only on what it allows is the failure
 * that matters. So each group below asserts a refusal and a permission.
 */

const tool = (name: string): Tool => ({
  name,
  description: name,
  parameters: [],
  async execute() {
    return "";
  },
});

describe("plan mode — the tools offered", () => {
  test("withholds every writing tool", () => {
    const offered = planModeTools(toolRegistery).map((entry) => entry.name);

    const writers = Object.entries(TOOL_EFFECTS)
      .filter(([, effect]) => effect === "write")
      .map(([name]) => name);

    // Guards the guard: if the registry ever lists no writing tools, the
    // assertion below would hold vacuously.
    expect(writers.length).toBeGreaterThan(0);
    for (const name of writers) expect(offered).not.toContain(name);
  });

  test("keeps reading, asking, planning and shell tools", () => {
    const offered = planModeTools(toolRegistery).map((entry) => entry.name);

    expect(offered).toContain("read_file");
    expect(offered).toContain("grep");
    expect(offered).toContain("ask_user");
    expect(offered).toContain("todo_write");
    // Inspection is most of what planning is, and the command-level gate is what
    // keeps this safe to offer.
    expect(offered).toContain("run_terminal");
  });

  test("withholds a tool nobody has classified", () => {
    const invented = tool("frobnicate");
    expect(toolEffect(invented.name)).toBe("unclassified");

    expect(planModeTools([...toolRegistery, invented]).map((e) => e.name)).not.toContain(
      "frobnicate",
    );
  });

  test("offers strictly fewer tools than Build mode", () => {
    expect(planModeTools(toolRegistery).length).toBeLessThan(toolRegistery.length);
  });
});

describe("plan mode — what is refused", () => {
  test("refuses the writing tools", () => {
    expect(blockedInPlanMode("edit_file", { path: "a.ts" })).toBe(true);
    expect(blockedInPlanMode("write_file", { path: "a.ts" })).toBe(true);
    expect(blockedInPlanMode("create_file", { path: "a.ts" })).toBe(true);
  });

  test("allows the tools that only look", () => {
    expect(blockedInPlanMode("read_file", { path: "a.ts" })).toBe(false);
    expect(blockedInPlanMode("grep", { pattern: "x" })).toBe(false);
    expect(blockedInPlanMode("glob", { pattern: "*.ts" })).toBe(false);
    expect(blockedInPlanMode("list_files", {})).toBe(false);
    expect(blockedInPlanMode("web_search", { query: "x" })).toBe(false);
  });

  test("allows asking the user, and recording a task list", () => {
    expect(blockedInPlanMode("ask_user", { questions: ["?"] })).toBe(false);
    expect(blockedInPlanMode("todo_write", { todos: [] })).toBe(false);
  });

  test("refuses an unclassified tool", () => {
    // Fail-closed: a tool added without an effect must not slip through the one
    // mode whose whole promise is that nothing changes.
    expect(blockedInPlanMode("frobnicate", {})).toBe(true);
  });

  describe("shell commands are judged by the command, not the tool", () => {
    test.each([
      ["sed -i 's/a/b/' cli.ts"],
      ["cat > notes.txt"],
      ["echo hi >> notes.txt"],
      ["rm -rf build"],
      ["mv a.ts b.ts"],
      ["cp a.ts b.ts"],
      ["mkdir generated"],
      ["touch empty.ts"],
      ["tee out.txt"],
      ["git checkout main"],
      [`python3 -c "open('f.txt','w').write('x')"`],
      [`node -e "require('fs').writeFileSync('f','x')"`],
      ["ls && sed -i s/a/b/ f.ts"],
    ])("refuses %s", (command) => {
      expect(blockedInPlanMode("run_terminal", { command })).toBe(true);
    });

    test.each([
      ["ls -la"],
      ["cat cli.ts"],
      ["git status"],
      ["git diff"],
      ["grep -rn foo ."],
      ["bun test"],
      ["bunx tsc --noEmit"],
      ["sed 's/a/b/' cli.ts"],
      ["rg pattern --files-with-matches"],
      ["ls 2>&1"],
    ])("allows %s", (command) => {
      expect(blockedInPlanMode("run_terminal", { command })).toBe(false);
    });

    test("reads the command from run_tests as well", () => {
      expect(blockedInPlanMode("run_tests", { command: "bun test" })).toBe(false);
      expect(blockedInPlanMode("run_tests", { command: "bun test && rm -rf dist" })).toBe(
        true,
      );
    });

    test("allows a shell tool called with no command at all", () => {
      // run_tests defaults to `bun test`, which writes nothing. An empty command
      // is not a write, and treating it as one would refuse the default.
      expect(blockedInPlanMode("run_terminal", {})).toBe(false);
    });
  });
});

describe("plan mode — the mode itself", () => {
  test("Tab flips between the two modes", () => {
    expect(nextSessionMode("build")).toBe("plan");
    expect(nextSessionMode("plan")).toBe("build");
  });

  test("labels are the ones the composer and turn footer show", () => {
    expect(sessionModeLabel("build")).toBe("Build");
    expect(sessionModeLabel("plan")).toBe("Plan");
  });

  test("the refusal names the tool, says nothing changed, and says what to do", () => {
    const refusal = planModeRefusal("edit_file");

    expect(refusal).toContain("edit_file");
    expect(refusal).toContain("plan mode");
    expect(refusal).toContain("unchanged");
    // The model has to be told not to go looking for another way through, or it
    // reaches for run_terminal next and spends the turn discovering both gates.
    expect(refusal).toContain("sed -i");
    expect(refusal.toLowerCase()).toContain("plan");
  });
});
