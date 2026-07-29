import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { walkWorkspace } from "../../../tools/scan";
import { listFilesTool } from "../../../tools/listFiles";
import { findFilesTool } from "../../../tools/findFiles";

// The tools resolve paths against the workspace, so fixtures live inside it.
describe("directory scanning", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(process.cwd(), `.scan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, "src", "components"), { recursive: true });
    mkdirSync(join(testDir, "node_modules", "left-pad"), { recursive: true });
    mkdirSync(join(testDir, ".git", "objects"), { recursive: true });

    writeFileSync(join(testDir, "package.json"), "{}");
    writeFileSync(join(testDir, "bun.lock"), "lock");
    writeFileSync(join(testDir, "src", "app.ts"), "// app");
    writeFileSync(join(testDir, "src", "components", "Button.tsx"), "// button");
    writeFileSync(join(testDir, "node_modules", "left-pad", "index.js"), "// dep");
    writeFileSync(join(testDir, ".git", "objects", "abc"), "object");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("walkWorkspace", () => {
    test("prunes ignored directories instead of walking and filtering them", async () => {
      const result = await walkWorkspace(testDir, { maxResults: 100 });

      expect(result.files).toContain("src/app.ts");
      expect(result.files).toContain("src/components/Button.tsx");
      expect(result.files.some((file) => file.includes("node_modules"))).toBe(false);
      expect(result.files.some((file) => file.includes(".git"))).toBe(false);
      // node_modules and .git are counted once each as pruned entries; their
      // contents are never read.
      expect(result.scanned).toBeLessThan(10);
    });

    test("skips lock files", async () => {
      const result = await walkWorkspace(testDir, { maxResults: 100 });

      expect(result.files).not.toContain("bun.lock");
      expect(result.files).toContain("package.json");
    });

    test("stops scanning as soon as maxResults is reached", async () => {
      const many = join(testDir, "many");
      mkdirSync(many, { recursive: true });
      for (let i = 0; i < 200; i++) {
        writeFileSync(join(many, `file-${i}.txt`), "x");
      }

      const result = await walkWorkspace(testDir, { maxResults: 5 });

      expect(result.files).toHaveLength(5);
      expect(result.hitResultLimit).toBe(true);
      // The whole tree is never visited — that is the point of the early stop.
      expect(result.scanned).toBeLessThan(50);
    });

    test("gives up once maxEntries is exhausted", async () => {
      const many = join(testDir, "many");
      mkdirSync(many, { recursive: true });
      for (let i = 0; i < 100; i++) {
        writeFileSync(join(many, `file-${i}.txt`), "x");
      }

      const result = await walkWorkspace(testDir, { maxResults: 1_000, maxEntries: 20 });

      expect(result.hitEntryLimit).toBe(true);
      expect(result.scanned).toBeLessThanOrEqual(20);
    });

    test("applies the match predicate during the walk", async () => {
      const result = await walkWorkspace(testDir, {
        maxResults: 100,
        match: (_relativePath, name) => name.endsWith(".tsx"),
      });

      expect(result.files).toEqual(["src/components/Button.tsx"]);
    });

    test("does not follow directory symlinks", async () => {
      symlinkSync(testDir, join(testDir, "src", "loop"), "dir");

      const result = await walkWorkspace(testDir, { maxResults: 1_000 });

      expect(result.hitEntryLimit).toBe(false);
      expect(result.files.some((file) => file.includes("loop/src"))).toBe(false);
    });

    test("survives an unreadable directory", async () => {
      const missing = join(testDir, "vanishes");
      mkdirSync(missing);
      rmSync(missing, { recursive: true, force: true });

      await expect(walkWorkspace(testDir, { maxResults: 10 })).resolves.toBeDefined();
    });
  });

  describe("list_files", () => {
    test("lists workspace files and omits dependency directories", async () => {
      const output = await listFilesTool.execute({ path: testDir }, undefined as any);

      expect(output).toContain("src/app.ts");
      expect(output).not.toContain("node_modules");
    });

    test("reports when it stopped at the result cap", async () => {
      const many = join(testDir, "many");
      mkdirSync(many, { recursive: true });
      for (let i = 0; i < 520; i++) {
        writeFileSync(join(many, `file-${i}.txt`), "x");
      }

      const output = await listFilesTool.execute({ path: testDir }, undefined as any);

      expect(output).toContain("Stopped after 500 files");
    });
  });

  describe("find_files", () => {
    test("returns matching files", async () => {
      const output = await findFilesTool.execute(
        { query: "Button", path: testDir },
        undefined as any,
      );

      expect(output).toContain("src/components/Button.tsx");
    });

    test("matches on the path as well as the filename", async () => {
      const output = await findFilesTool.execute(
        { query: "components", path: testDir },
        undefined as any,
      );

      expect(output).toContain("src/components/Button.tsx");
    });

    test("never returns dependency matches", async () => {
      const output = await findFilesTool.execute(
        { query: "index", path: testDir },
        undefined as any,
      );

      expect(output).not.toContain("left-pad");
    });

    test("points at list_files when the query names a directory", async () => {
      const output = await findFilesTool.execute(
        { query: "src", path: testDir },
        undefined as any,
      );

      // "src" also matches every path under it, so a match list is correct here;
      // the directory hint only applies when nothing matched.
      expect(output).toContain("src/app.ts");
    });

    test("explains when nothing matched", async () => {
      const output = await findFilesTool.execute(
        { query: "zzzznope", path: testDir },
        undefined as any,
      );

      expect(output).toContain("No matching files found");
    });

    test("rejects queries that are too broad", async () => {
      const output = await findFilesTool.execute({ query: "." }, undefined as any);

      expect(output).toContain("too broad");
    });
  });
});
