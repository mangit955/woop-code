import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MAX_CONTEXT_FILE_BYTES,
  MAX_INSTRUCTIONS_CHARS,
  MAX_PACKAGE_JSON_CHARS,
  MAX_README_CHARS,
  MAX_REPO_CONTEXT_CHARS,
  buildRepositoryContext,
  readAgentInstructions,
  readPackageJson,
  readReadme,
  truncate,
} from "../../../config/config";

// The context builders read from process.cwd(), so each test runs inside a
// throwaway repository and the original directory is restored afterwards.
const originalCwd = process.cwd();
let repoDir: string | undefined;

function createRepo(files: Record<string, string>): string {
  repoDir = mkdtempSync(join(tmpdir(), "woopcode-repo-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(repoDir, name), contents);
  }
  process.chdir(repoDir);
  return repoDir;
}

afterEach(() => {
  process.chdir(originalCwd);
  if (repoDir) {
    rmSync(repoDir, { recursive: true, force: true });
    repoDir = undefined;
  }
});

describe("truncate", () => {
  test("leaves text under the limit untouched", () => {
    expect(truncate("short", 100, "hint")).toBe("short");
  });

  test("cuts to the limit and says what was dropped", () => {
    const result = truncate("x".repeat(500), 100, "read the file");

    expect(result.length).toBeLessThan(200);
    expect(result).toContain("more characters omitted");
    expect(result).toContain("read the file");
  });

  test("prefers a line boundary so the cut is not mid-line", () => {
    const text = `${"a".repeat(60)}\n${"b".repeat(200)}`;

    expect(truncate(text, 100, "hint").split("\n")[0]).toBe("a".repeat(60));
  });
});

describe("package.json context", () => {
  test("is summarised, not inlined", async () => {
    createRepo({
      "package.json": JSON.stringify({
        name: "demo",
        version: "1.2.3",
        description: "A demo",
        scripts: { build: "tsc -p . --incremental --pretty false" },
        dependencies: { react: "^19.0.0" },
      }),
    });

    const summary = await readPackageJson();

    expect(summary).toContain("name: demo@1.2.3");
    expect(summary).toContain("scripts: build");
    expect(summary).toContain("dependencies: react");
    // Version ranges and script bodies are noise for the agent.
    expect(summary).not.toContain("^19.0.0");
    expect(summary).not.toContain("--incremental");
  });

  test("caps a huge dependency list", async () => {
    const dependencies = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`pkg-${index}`, "^1.0.0"]),
    );
    createRepo({ "package.json": JSON.stringify({ name: "big", dependencies }) });

    const summary = await readPackageJson();

    expect(summary).toContain("more)");
    expect(summary.length).toBeLessThanOrEqual(MAX_PACKAGE_JSON_CHARS + 200);
  });

  test("falls back to a bounded slice when the file is malformed", async () => {
    createRepo({ "package.json": `{"name": "broken",${"x".repeat(5_000)}` });

    const summary = await readPackageJson();

    expect(summary).toContain("more characters omitted");
    expect(summary.length).toBeLessThanOrEqual(MAX_PACKAGE_JSON_CHARS + 200);
  });

  test("is empty when there is no package.json", async () => {
    createRepo({});

    expect(await readPackageJson()).toBe("");
  });
});

describe("README context", () => {
  test("is truncated with a pointer to the full file", async () => {
    createRepo({ "README.md": "line\n".repeat(5_000) });

    const readme = await readReadme();

    expect(readme.length).toBeLessThanOrEqual(MAX_README_CHARS + 200);
    expect(readme).toContain("read README.md for the rest");
  });

  test("a short README is passed through unchanged", async () => {
    createRepo({ "README.md": "# Tiny\n\nAll of it." });

    expect(await readReadme()).toBe("# Tiny\n\nAll of it.");
  });

  test("an oversized file is skipped rather than read into memory", async () => {
    createRepo({ "README.md": "x".repeat(MAX_CONTEXT_FILE_BYTES + 1) });

    expect(await readReadme()).toBe("");
  });
});

describe("buildRepositoryContext", () => {
  test("stays within the overall budget for a large repository", async () => {
    createRepo({
      "README.md": "readme line\n".repeat(20_000),
      "package.json": JSON.stringify({
        name: "big",
        dependencies: Object.fromEntries(
          Array.from({ length: 500 }, (_, index) => [`pkg-${index}`, "^1.0.0"]),
        ),
      }),
    });

    const context = await buildRepositoryContext();

    expect(context.length).toBeLessThanOrEqual(MAX_REPO_CONTEXT_CHARS + 200);
    expect(context).toContain("Repository Context");
  });

  test("still describes a repository with neither file", async () => {
    createRepo({});

    const context = await buildRepositoryContext();

    expect(context).toContain("Repository Context");
    expect(context.length).toBeLessThan(MAX_REPO_CONTEXT_CHARS);
  });
});

describe("repository instructions", () => {
  test("AGENTS.md is preferred over the other names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woopcode-instructions-"));
    writeFileSync(join(dir, "AGENTS.md"), "Use Bun, never Node.");
    writeFileSync(join(dir, "CLAUDE.md"), "Some other tool's copy.");

    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const found = await readAgentInstructions();
      expect(found?.name).toBe("AGENTS.md");
      expect(found?.text).toContain("Use Bun, never Node.");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("another tool's file is read rather than ignored on branding grounds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woopcode-instructions-"));
    writeFileSync(join(dir, "CLAUDE.md"), "Prefer Bun.serve over express.");

    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const found = await readAgentInstructions();
      expect(found?.name).toBe("CLAUDE.md");
      expect(found?.text).toContain("Bun.serve");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a repository with no instructions yields nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woopcode-instructions-"));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await readAgentInstructions()).toBeNull();
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty instructions file is not treated as instructions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woopcode-instructions-"));
    writeFileSync(join(dir, "AGENTS.md"), "   \n\n");
    writeFileSync(join(dir, "CLAUDE.md"), "Real content here.");

    const cwd = process.cwd();
    process.chdir(dir);
    try {
      // Falling through matters: an empty placeholder must not shadow a file
      // that actually says something.
      expect((await readAgentInstructions())?.name).toBe("CLAUDE.md");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("oversized instructions are bounded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woopcode-instructions-"));
    writeFileSync(join(dir, "AGENTS.md"), "rule\n".repeat(5_000));

    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const found = await readAgentInstructions();
      expect(found!.text.length).toBeLessThan(MAX_INSTRUCTIONS_CHARS + 200);
      expect(found!.text).toContain("read AGENTS.md for the rest");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("instructions appear before the README in the assembled context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woopcode-instructions-"));
    writeFileSync(join(dir, "AGENTS.md"), "INSTRUCTION-MARKER");
    writeFileSync(join(dir, "README.md"), "README-MARKER");

    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const context = await buildRepositoryContext();
      // The overall ceiling cuts from the end, so ordering decides what
      // survives in a repository with a large README.
      expect(context.indexOf("INSTRUCTION-MARKER")).toBeLessThan(
        context.indexOf("README-MARKER"),
      );
      expect(context).toContain("follow these");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
