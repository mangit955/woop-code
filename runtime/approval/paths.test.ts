import { describe, expect, test } from "bun:test";
import { escapesWorkspace, normalizePath, UNRESOLVABLE, workspaceContext } from "./paths";

const WORKSPACE = { root: "/workspace", home: "/home/dev" };

const locationOf = (raw: string) => normalizePath(raw, WORKSPACE).location;

describe("normalizing a path", () => {
  test("resolves the spellings of a path inside the workspace", () => {
    expect(normalizePath("src/index.ts", WORKSPACE).absolute).toBe("/workspace/src/index.ts");
    expect(normalizePath("./src/index.ts", WORKSPACE).absolute).toBe("/workspace/src/index.ts");
    expect(normalizePath("a/../b", WORKSPACE).absolute).toBe("/workspace/b");
    expect(normalizePath("/workspace/cli.ts", WORKSPACE).absolute).toBe("/workspace/cli.ts");
  });

  test("expands ~ against the given home, not the process's", () => {
    expect(normalizePath("~/.ssh/id_rsa", WORKSPACE).absolute).toBe("/home/dev/.ssh/id_rsa");
  });

  test("the root itself is inside", () => {
    expect(locationOf("/workspace")).toBe("inside");
    expect(locationOf(".")).toBe("inside");
  });
});

describe("locating a path", () => {
  test("paths under the root are inside", () => {
    expect(locationOf("src/index.ts")).toBe("inside");
    expect(locationOf("a/../b")).toBe("inside");
    expect(locationOf("/workspace/nested/deep.ts")).toBe("inside");
  });

  test("paths elsewhere are outside", () => {
    expect(locationOf("/etc/hosts")).toBe("outside");
    expect(locationOf("~/.ssh/id_rsa")).toBe("outside");
    expect(locationOf("../sibling")).toBe("outside");
    expect(locationOf("a/../../escaped")).toBe("outside");
  });

  test("a sibling that merely starts with the root's name is outside", () => {
    expect(locationOf("/workspace-other/x")).toBe("outside");
  });

  test("what the shell expands, we cannot", () => {
    expect(locationOf("$HOME/x")).toBe("unknown");
    expect(locationOf("${TARGET}")).toBe("unknown");
    expect(locationOf("`pwd`/x")).toBe("unknown");
    expect(locationOf("%APPDATA%/x")).toBe("unknown");
    expect(locationOf(UNRESOLVABLE)).toBe("unknown");
    expect(locationOf("")).toBe("unknown");
  });

  test("another account's home cannot be resolved", () => {
    expect(locationOf("~root/.ssh")).toBe("unknown");
  });

  test("a windows path is not a relative path", () => {
    // Joining `C:\x` onto a POSIX root would make it look local.
    expect(locationOf("C:\\Windows\\System32")).toBe(process.platform === "win32" ? "outside" : "unknown");
  });

  test("~ with no home to expand is unknown", () => {
    expect(normalizePath("~/x", { root: "/workspace" }).location).toBe("unknown");
  });
});

describe("escaping the workspace", () => {
  test("anything not provably inside escapes", () => {
    expect(escapesWorkspace("src/index.ts", WORKSPACE)).toBe(false);
    expect(escapesWorkspace("/etc/hosts", WORKSPACE)).toBe(true);
    // Not "I don't know" — the same answer as /etc, on purpose.
    expect(escapesWorkspace("$HOME/x", WORKSPACE)).toBe(true);
  });
});

describe("the default context", () => {
  test("is the process working directory", () => {
    expect(workspaceContext().root).toBe(process.cwd());
  });

  test("resolves a relative root it is handed", () => {
    expect(workspaceContext({ root: "." }).root).toBe(process.cwd());
  });
});

describe("containment is off unless it is asked for", () => {
  // The security-relevant default. Every caller that predates sandboxing, and
  // every future one that does not think about it, has to be graded as running
  // on the real machine — a permission that can be granted by forgetting to
  // mention it is a permission that will be.
  test("an absent flag is not containment", () => {
    expect(workspaceContext().contained).toBe(false);
    expect(workspaceContext({ root: "/workspace" }).contained).toBe(false);
  });

  test("only an explicit true counts", () => {
    expect(workspaceContext({ contained: true }).contained).toBe(true);
    expect(workspaceContext({ contained: false }).contained).toBe(false);
    // Truthiness is not consent: a stray value must not widen anything.
    expect(workspaceContext({ contained: "yes" as unknown as boolean }).contained).toBe(false);
    expect(workspaceContext({ contained: 1 as unknown as boolean }).contained).toBe(false);
  });
});
