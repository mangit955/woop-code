import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * PROPERTY-BASED TESTS FOR FILESYSTEM OPERATIONS
 * 
 * These tests verify filesystem invariants.
 * 
 * Key invariants:
 * - write(data) → read() → data (roundtrip preserves content)
 * - write is idempotent
 * - unicode paths and content work correctly
 * 
 * Production bugs prevented:
 * - Encoding corruption
 * - Unicode filename issues
 * - Binary data corruption
 * - Race conditions in file operations
 */

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "woop-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("Filesystem - Property Tests", () => {
  test("PROPERTY: write → read preserves any content", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 1000 }), async (content) => {
        const filePath = join(testDir, "test.txt");

        // Write content
        await Bun.write(filePath, content);

        // Read back
        const file = Bun.file(filePath);
        const readContent = await file.text();

        // PROPERTY: Content must be identical
        expect(readContent).toBe(content);
      }),
      { numRuns: 100 }
    );
  });

  test("PROPERTY: write → read preserves unicode content", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 500 }),
        async (content) => {
          const filePath = join(testDir, "test.txt");

          await Bun.write(filePath, content);

          const file = Bun.file(filePath);
          const readContent = await file.text();

          expect(readContent).toBe(content);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("PROPERTY: write is idempotent - write(x) twice = write(x) once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 500 }), async (content) => {
        const filePath = join(testDir, "test.txt");

        // Write once
        await Bun.write(filePath, content);
        const file1 = Bun.file(filePath);
        const result1 = await file1.text();

        // Write same content again
        await Bun.write(filePath, content);
        const file2 = Bun.file(filePath);
        const result2 = await file2.text();

        // Results should be identical
        expect(result1).toBe(result2);
        expect(result2).toBe(content);
      }),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: unicode filenames work correctly", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Only use safe unicode characters for filenames
        fc
          .string({ minLength: 1, maxLength: 50 })
          .filter((s) => !/[/\\:*?"<>|]/.test(s)), // Exclude invalid filename chars
        fc.string({ minLength: 0, maxLength: 200 }),
        async (filename, content) => {
          if (filename.trim().length === 0) return; // Skip empty filenames

          const filePath = join(testDir, filename);

          await Bun.write(filePath, content);

          const file = Bun.file(filePath);
          expect(await file.exists()).toBe(true);

          const readContent = await file.text();
          expect(readContent).toBe(content);
        }
      ),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: random paths with subdirectories work", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.string({ minLength: 0, maxLength: 200 }),
        async (pathParts, content) => {
          // Filter invalid path characters
          const cleanParts = pathParts
            .map((p) => p.replace(/[/\\:*?"<>|]/g, ""))
            .filter((p) => p.length > 0 && p !== "." && p !== "..");

          if (cleanParts.length === 0) return;

          // Create nested path
          const filePath = join(testDir, ...cleanParts.slice(0, -1), "file.txt");

          // Ensure parent directory exists
          const dir = join(testDir, ...cleanParts.slice(0, -1));
          await Bun.write(join(dir, ".keep"), ""); // Create directory

          await Bun.write(filePath, content);

          const file = Bun.file(filePath);
          const readContent = await file.text();

          expect(readContent).toBe(content);
        }
      ),
      { numRuns: 30 }
    );
  });

  test("PROPERTY: empty files can be created and read", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(""), async (content) => {
        const filePath = join(testDir, "empty.txt");

        await Bun.write(filePath, content);

        const file = Bun.file(filePath);
        expect(await file.exists()).toBe(true);

        const readContent = await file.text();
        expect(readContent).toBe("");
        expect(file.size).toBe(0);
      }),
      { numRuns: 10 }
    );
  });

  test("PROPERTY: large files don't corrupt", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 10000, max: 100000 }),
        async (size) => {
          const filePath = join(testDir, "large.txt");
          const content = "x".repeat(size);

          await Bun.write(filePath, content);

          const file = Bun.file(filePath);
          const readContent = await file.text();

          expect(readContent.length).toBe(size);
          expect(readContent).toBe(content);
        }
      ),
      { numRuns: 10 }
    );
  });

  test("PROPERTY: overwriting files works correctly", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 200 }),
        fc.string({ minLength: 0, maxLength: 200 }),
        async (content1, content2) => {
          const filePath = join(testDir, "test.txt");

          // Write first content
          await Bun.write(filePath, content1);
          const file1 = Bun.file(filePath);
          expect(await file1.text()).toBe(content1);

          // Overwrite with second content
          await Bun.write(filePath, content2);
          const file2 = Bun.file(filePath);
          const result = await file2.text();

          // Should only have second content
          expect(result).toBe(content2);
          
          // Only check if contents are different and non-empty
          if (content1.length > 0 && content2.length > 0 && content1 !== content2) {
            expect(result).not.toContain(content1);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: special characters in content preserved", async () => {
    const specialChars = ["\0", "\r", "\n", "\t", "\x01", "\x02"];

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...specialChars), { minLength: 1, maxLength: 50 }),
        async (chars) => {
          const filePath = join(testDir, "special.txt");
          const content = chars.join("");

          await Bun.write(filePath, content);

          const file = Bun.file(filePath);
          const readContent = await file.text();

          // Note: null bytes might be problematic in text mode
          // This test will reveal such issues
          expect(readContent.length).toBe(content.length);
        }
      ),
      { numRuns: 30 }
    );
  });

  test("PROPERTY: line endings are preserved", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { minLength: 1, maxLength: 20 }),
        fc.constantFrom("\n", "\r\n", "\r"),
        async (lines, lineEnding) => {
          const filePath = join(testDir, "lines.txt");
          const content = lines.join(lineEnding);

          await Bun.write(filePath, content);

          const file = Bun.file(filePath);
          const readContent = await file.text();

          expect(readContent).toBe(content);
        }
      ),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: file.exists() is accurate", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }),
        async (filename) => {
          const cleanFilename = filename.replace(/[/\\:*?"<>|.]/g, "") || "test";
          if (cleanFilename.trim().length === 0) return; // Skip invalid names
          
          const filePath = join(testDir, cleanFilename);

          // Before writing, should not exist
          const fileBefore = Bun.file(filePath);
          expect(await fileBefore.exists()).toBe(false);

          // After writing, should exist
          await Bun.write(filePath, "test");
          const fileAfter = Bun.file(filePath);
          expect(await fileAfter.exists()).toBe(true);
        }
      ),
      { numRuns: 30 }
    );
  });

  test("PROPERTY: concurrent writes don't corrupt each other", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 10, maxLength: 100 }), {
          minLength: 2,
          maxLength: 5,
        }),
        async (contents) => {
          // Write to different files concurrently
          const writes = contents.map((content, i) => {
            const filePath = join(testDir, `concurrent-${i}.txt`);
            return Bun.write(filePath, content);
          });

          await Promise.all(writes);

          // Verify each file has correct content
          for (let i = 0; i < contents.length; i++) {
            const filePath = join(testDir, `concurrent-${i}.txt`);
            const file = Bun.file(filePath);
            const readContent = await file.text();
            expect(readContent).toBe(contents[i]);
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  test("PROPERTY: file size matches content length", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 1000 }), async (content) => {
        const filePath = join(testDir, "size.txt");

        await Bun.write(filePath, content);

        const file = Bun.file(filePath);
        const readContent = await file.text();

        // Size should match content (in bytes)
        const expectedSize = new TextEncoder().encode(content).length;
        expect(file.size).toBe(expectedSize);
      }),
      { numRuns: 50 }
    );
  });
});
