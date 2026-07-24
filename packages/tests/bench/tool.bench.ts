import { bench, describe, beforeAll, mock } from "bun:test";
import { readFileTool } from "../../../tools/readFile";
import { writeFileTool } from "../../../tools/writeFile";
import { editFileTool } from "../../../tools/editFile";
import { terminalTool } from "../../../tools/terminal";
import { tmpdir } from "os";
import { join } from "path";

/**
 * PERFORMANCE BENCHMARKS FOR TOOLS
 * 
 * These measure tool execution performance to detect
 * performance regressions.
 * 
 * Baseline expectations:
 * - ReadFile (16KB): <5ms
 * - WriteFile (1MB): <50ms
 * - Terminal (echo): <10ms
 */

let testDir: string;
let mockStore: any;

beforeAll(() => {
  // Create temp directory
  testDir = join(tmpdir(), `woop-bench-${Date.now()}`);
  Bun.spawnSync(["mkdir", "-p", testDir]);

  // Mock UI store
  mockStore = {
    setPendingEdit: mock(async () => true),
  };

  mock.module("../../../tui/src/store/ui-store", () => ({
    store: mockStore,
  }));
});

describe("ReadFile Tool Benchmarks", () => {
  bench("readFile - 1KB file", async () => {
    const path = join(testDir, "1kb.txt");
    await Bun.write(path, "x".repeat(1024));
    await readFileTool.execute({ path });
  });

  bench("readFile - 16KB file (at limit)", async () => {
    const path = join(testDir, "16kb.txt");
    await Bun.write(path, "x".repeat(16 * 1024));
    await readFileTool.execute({ path });
  });

  bench("readFile - 1MB file (truncated)", async () => {
    const path = join(testDir, "1mb.txt");
    await Bun.write(path, "x".repeat(1024 * 1024));
    await readFileTool.execute({ path });
  });

  bench("readFile - unicode content", async () => {
    const path = join(testDir, "unicode.txt");
    await Bun.write(path, "世界 🚀 ".repeat(1000));
    await readFileTool.execute({ path });
  });
});

describe("WriteFile Tool Benchmarks", () => {
  bench("writeFile - 1KB file", async () => {
    const path = join(testDir, "write-1kb.txt");
    await Bun.write(path, "original");
    await writeFileTool.execute({
      path,
      content: "x".repeat(1024),
    });
  });

  bench("writeFile - 100KB file", async () => {
    const path = join(testDir, "write-100kb.txt");
    await Bun.write(path, "original");
    await writeFileTool.execute({
      path,
      content: "x".repeat(100 * 1024),
    });
  });

  bench("writeFile - 1MB file", async () => {
    const path = join(testDir, "write-1mb.txt");
    await Bun.write(path, "original");
    await writeFileTool.execute({
      path,
      content: "x".repeat(1024 * 1024),
    });
  });

  bench("writeFile - diff generation (small change)", async () => {
    const path = join(testDir, "diff-small.txt");
    const original = "line1\nline2\nline3\nline4\nline5";
    await Bun.write(path, original);
    await writeFileTool.execute({
      path,
      content: "line1\nMODIFIED\nline3\nline4\nline5",
    });
  });
});

describe("EditFile Tool Benchmarks", () => {
  bench("editFile - small replacement", async () => {
    const path = join(testDir, "edit-small.txt");
    await Bun.write(path, "hello world");
    await editFileTool.execute({
      path,
      oldText: "world",
      newText: "universe",
    });
  });

  bench("editFile - large file (1MB) replacement", async () => {
    const path = join(testDir, "edit-large.txt");
    const content = "START\n" + "x".repeat(1024 * 1024) + "\nEND";
    await Bun.write(path, content);
    await editFileTool.execute({
      path,
      oldText: "START",
      newText: "MODIFIED",
    });
  });

  bench("editFile - multiline replacement", async () => {
    const path = join(testDir, "edit-multiline.txt");
    await Bun.write(path, "line1\nline2\nline3\nline4\nline5");
    await editFileTool.execute({
      path,
      oldText: "line2\nline3",
      newText: "REPLACED",
    });
  });
});

describe("Terminal Tool Benchmarks", () => {
  bench("terminal - simple echo", async () => {
    await terminalTool.execute({
      command: "echo hello",
    });
  });

  bench("terminal - command with pipes", async () => {
    await terminalTool.execute({
      command: "echo 'hello world' | grep hello",
    });
  });

  bench("terminal - generate output (1KB)", async () => {
    await terminalTool.execute({
      command: "head -c 1024 /dev/zero | base64",
    });
  });

  bench("terminal - generate output (100KB)", async () => {
    await terminalTool.execute({
      command: "head -c 102400 /dev/zero | base64",
    });
  });

  bench("terminal - sequential commands", async () => {
    await terminalTool.execute({
      command: "echo 'first' && echo 'second' && echo 'third'",
    });
  });
});
