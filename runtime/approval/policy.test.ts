import { describe, expect, test } from "bun:test";
import { ApprovalMode, DEFAULT_APPROVAL_MODE, parseApprovalMode } from "./approval-mode";
import { CommandRisk, classifyCommand } from "./classifier";
import { createApprovalPolicy, requiresApproval } from "./policy";

const ALL_RISKS = [
  CommandRisk.READ_ONLY,
  CommandRisk.WORKSPACE_WRITE,
  CommandRisk.DESTRUCTIVE,
  CommandRisk.SYSTEM,
];

describe("ALWAYS_ASK", () => {
  test("preserves the original behaviour: everything is confirmed", () => {
    for (const risk of ALL_RISKS) {
      expect(requiresApproval(ApprovalMode.ALWAYS_ASK, risk)).toBe(true);
    }
  });
});

describe("AUTO_READ_ONLY", () => {
  test("runs reads unattended", () => {
    expect(requiresApproval(ApprovalMode.AUTO_READ_ONLY, CommandRisk.READ_ONLY)).toBe(false);
  });

  test("asks before anything writes", () => {
    expect(requiresApproval(ApprovalMode.AUTO_READ_ONLY, CommandRisk.WORKSPACE_WRITE)).toBe(true);
    expect(requiresApproval(ApprovalMode.AUTO_READ_ONLY, CommandRisk.DESTRUCTIVE)).toBe(true);
    expect(requiresApproval(ApprovalMode.AUTO_READ_ONLY, CommandRisk.SYSTEM)).toBe(true);
  });
});

describe("AUTO_WORKSPACE", () => {
  test("runs reads and workspace writes unattended", () => {
    expect(requiresApproval(ApprovalMode.AUTO_WORKSPACE, CommandRisk.READ_ONLY)).toBe(false);
    expect(requiresApproval(ApprovalMode.AUTO_WORKSPACE, CommandRisk.WORKSPACE_WRITE)).toBe(false);
  });

  test("still asks before deleting or touching the system", () => {
    expect(requiresApproval(ApprovalMode.AUTO_WORKSPACE, CommandRisk.DESTRUCTIVE)).toBe(true);
    expect(requiresApproval(ApprovalMode.AUTO_WORKSPACE, CommandRisk.SYSTEM)).toBe(true);
  });
});

describe("FULL_AUTO", () => {
  test("asks for nothing", () => {
    for (const risk of ALL_RISKS) {
      expect(requiresApproval(ApprovalMode.FULL_AUTO, risk)).toBe(false);
    }
  });
});

describe("the guarantee across every mode", () => {
  test("only FULL_AUTO ever runs a destructive or system command unattended", () => {
    // This is the promise the modes are arranged around, so it is asserted
    // directly rather than left to the ordering of an enum.
    for (const mode of Object.values(ApprovalMode)) {
      if (mode === ApprovalMode.FULL_AUTO) continue;

      expect(requiresApproval(mode, CommandRisk.DESTRUCTIVE)).toBe(true);
      expect(requiresApproval(mode, CommandRisk.SYSTEM)).toBe(true);
    }
  });

  test("a stricter mode never approves more than a looser one", () => {
    const order = [
      ApprovalMode.ALWAYS_ASK,
      ApprovalMode.AUTO_READ_ONLY,
      ApprovalMode.AUTO_WORKSPACE,
      ApprovalMode.FULL_AUTO,
    ];

    for (let index = 1; index < order.length; index++) {
      for (const risk of ALL_RISKS) {
        const stricter = requiresApproval(order[index - 1]!, risk);
        const looser = requiresApproval(order[index]!, risk);
        // Loosening a mode may drop an approval, never add one.
        expect(stricter || !looser).toBe(true);
      }
    }
  });
});

describe("policy objects", () => {
  test("carry their mode and answer the same way as the function", () => {
    const policy = createApprovalPolicy(ApprovalMode.AUTO_READ_ONLY);

    expect(policy.mode).toBe(ApprovalMode.AUTO_READ_ONLY);
    expect(policy.autoApprovesUpTo).toBe(CommandRisk.READ_ONLY);
    for (const risk of ALL_RISKS) {
      expect(policy.requiresApproval(risk)).toBe(
        requiresApproval(ApprovalMode.AUTO_READ_ONLY, risk),
      );
    }
  });

  test("ALWAYS_ASK auto-approves nothing at all", () => {
    expect(createApprovalPolicy(ApprovalMode.ALWAYS_ASK).autoApprovesUpTo).toBeNull();
  });
});

describe("mode parsing", () => {
  test("accepts the values written to config", () => {
    expect(parseApprovalMode("always-ask")).toBe(ApprovalMode.ALWAYS_ASK);
    expect(parseApprovalMode("auto-read-only")).toBe(ApprovalMode.AUTO_READ_ONLY);
    expect(parseApprovalMode("auto-workspace")).toBe(ApprovalMode.AUTO_WORKSPACE);
    expect(parseApprovalMode("full-auto")).toBe(ApprovalMode.FULL_AUTO);
  });

  test("tolerates casing and surrounding space", () => {
    expect(parseApprovalMode("  Auto-Read-Only  ")).toBe(ApprovalMode.AUTO_READ_ONLY);
  });

  test("an unreadable setting can never widen permissions", () => {
    // A typo must not land on full-auto, so everything unknown is the default.
    for (const value of [undefined, null, 42, {}, "", "yolo", "FULL AUTO"]) {
      expect(parseApprovalMode(value)).toBe(DEFAULT_APPROVAL_MODE);
    }
    expect(DEFAULT_APPROVAL_MODE).not.toBe(ApprovalMode.FULL_AUTO);
  });
});

describe("end to end: the examples from the specification", () => {
  const auto = createApprovalPolicy(ApprovalMode.AUTO_READ_ONLY);
  const asks = (command: string) => auto.requiresApproval(classifyCommand(command));

  test("inspection runs immediately", () => {
    expect(asks("git status")).toBe(false);
    expect(asks('rg "TODO" src')).toBe(false);
    expect(asks("cat package.json")).toBe(false);
    expect(asks("bun test")).toBe(false);
  });

  test("modifying the repository asks", () => {
    expect(asks("git add .")).toBe(true);
    expect(asks('git commit -m "wip"')).toBe(true);
  });

  test("destructive and system commands ask", () => {
    expect(asks("rm -rf node_modules")).toBe(true);
    expect(asks("git reset --hard")).toBe(true);
    expect(asks("sudo rm -rf /")).toBe(true);
  });

  test("workspace mode lets the writes through but not the deletes", () => {
    const workspace = createApprovalPolicy(ApprovalMode.AUTO_WORKSPACE);
    const wants = (command: string) => workspace.requiresApproval(classifyCommand(command));

    expect(wants("mkdir -p src/new")).toBe(false);
    expect(wants("touch src/new.ts")).toBe(false);
    expect(wants("mv src/a.ts src/b.ts")).toBe(false);
    expect(wants("git add .")).toBe(false);
    expect(wants("rm -rf node_modules")).toBe(true);
    expect(wants("git clean -fd")).toBe(true);
    expect(wants("chmod +x x.sh")).toBe(true);
  });
});
