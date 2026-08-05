import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readImageTool, takePendingImages } from "../../../tools/readImage";

/**
 * INTEGRATION TESTS for the read_image tool.
 *
 * Real files, and inside the workspace: the tool routes through
 * `resolveWorkspacePath`, which refuses anything outside it, so a fixture in
 * `tmpdir()` would be rejected before any of this was exercised.
 *
 * The fixtures are built headers rather than photographs. That is what the tool
 * reads — it identifies the format from magic bytes and takes the dimensions
 * from the header, and never decodes a pixel — so a crafted header exercises
 * exactly the code under test. The bytes are real ones in the real layout.
 *
 * UUID in the directory name because `Date.now()` collides between concurrent
 * runs, and the loser has its fixtures deleted mid-test.
 */

const fixtures = join(process.cwd(), `.test-images-${crypto.randomUUID()}`);
mkdirSync(fixtures, { recursive: true });

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

/** A PNG whose IHDR declares the given size. */
async function writePng(name: string, width: number, height: number): Promise<string> {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);

  const path = join(fixtures, name);
  await Bun.write(path, bytes);
  return path;
}

/** A JPEG with a single SOF0 segment declaring the given size. */
async function writeJpeg(name: string, width: number, height: number): Promise<string> {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8, 0xff], 0); // SOI, then the first marker
  bytes[3] = 0xc0; // SOF0
  view.setUint16(4, 11); // segment length
  bytes[6] = 8; // sample precision
  view.setUint16(7, height);
  view.setUint16(9, width);

  const path = join(fixtures, name);
  await Bun.write(path, bytes);
  return path;
}

/** The path as the tool is given it: relative to the workspace. */
const relative = (absolute: string) => absolute.slice(process.cwd().length + 1);

describe("read_image Tool - Integration Tests", () => {
  beforeEach(() => {
    // A queued image from an earlier test would be attributed to this one.
    takePendingImages();
  });

  describe("Argument validation", () => {
    test("rejects a call with no arguments", async () => {
      expect(readImageTool.execute({})).rejects.toThrow(/File path is required/);
    });

    test("rejects an empty path", async () => {
      expect(readImageTool.execute({ path: "   " })).rejects.toThrow(
        /File path is required/,
      );
    });

    test("names a missing file rather than reporting ENOENT", async () => {
      expect(readImageTool.execute({ path: "no-such-image.png" })).rejects.toThrow(
        /no-such-image\.png does not exist/,
      );
    });

    test("refuses a path outside the workspace", async () => {
      expect(readImageTool.execute({ path: "../../../etc/hosts" })).rejects.toThrow(
        /escapes the workspace/,
      );
    });

    test("queues nothing when the call is rejected", async () => {
      await readImageTool.execute({ path: "missing.png" }).catch(() => {});
      expect(takePendingImages()).toEqual([]);
    });
  });

  describe("Format detection", () => {
    test("identifies a PNG and reports its dimensions", async () => {
      const path = await writePng("shot.png", 1920, 1080);
      const result = await readImageTool.execute({ path: relative(path) });

      expect(result).toContain("1920x1080");
      expect(result).toContain("image/png");
    });

    test("identifies a JPEG and reports its dimensions", async () => {
      const path = await writeJpeg("frame.jpg", 640, 480);
      const result = await readImageTool.execute({ path: relative(path) });

      expect(result).toContain("640x480");
      expect(result).toContain("image/jpeg");
    });

    test("judges the format by its bytes, not its extension", async () => {
      // A PNG named .jpg. Trusting the extension would report the wrong media
      // type to the provider, which rejects the request rather than guessing.
      const path = await writePng("actually-a-png.jpg", 8, 8);
      const result = await readImageTool.execute({ path: relative(path) });

      expect(result).toContain("image/png");
    });

    test("refuses a file that is not an image, and says what to use", async () => {
      const path = join(fixtures, "notes.txt");
      await Bun.write(path, "just text");

      expect(readImageTool.execute({ path: relative(path) })).rejects.toThrow(
        /not a PNG, JPEG, GIF or WebP.*read_file/s,
      );
    });

    test("refuses an empty file", async () => {
      const path = join(fixtures, "empty.png");
      await Bun.write(path, "");

      expect(readImageTool.execute({ path: relative(path) })).rejects.toThrow(/is empty/);
    });

    test("refuses an image too large for a provider, with a way forward", async () => {
      const path = join(fixtures, "huge.png");
      const bytes = new Uint8Array(4 * 1024 * 1024);
      bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
      await Bun.write(path, bytes);

      expect(readImageTool.execute({ path: relative(path) })).rejects.toThrow(
        /over the.*Resize or crop/s,
      );
    });
  });

  describe("Queueing", () => {
    test("queues the resolved path and media type for the loop to attach", async () => {
      const path = await writePng("queued.png", 4, 4);
      await readImageTool.execute({ path: relative(path) });

      const pending = takePendingImages();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.mediaType).toBe("image/png");
      // Absolute and resolved, so a later cwd change cannot strand it.
      expect(pending[0]!.path).toBe(path);
    });

    test("taking the queue empties it", async () => {
      const path = await writePng("once.png", 4, 4);
      await readImageTool.execute({ path: relative(path) });

      expect(takePendingImages()).toHaveLength(1);
      expect(takePendingImages()).toEqual([]);
    });

    test("two reads queue two images in order", async () => {
      const first = await writePng("one.png", 2, 2);
      const second = await writeJpeg("two.jpg", 3, 3);

      await readImageTool.execute({ path: relative(first) });
      await readImageTool.execute({ path: relative(second) });

      expect(takePendingImages().map((image) => image.mediaType)).toEqual([
        "image/png",
        "image/jpeg",
      ]);
    });
  });
});
