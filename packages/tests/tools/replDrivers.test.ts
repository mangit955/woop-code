import { test, expect, describe, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { REPL_DRIVERS, type ReplLanguage } from "../../../tools/replDrivers";

/**
 * The drivers, launched both ways a real executor launches them.
 *
 * This file exists because of a mutation that should have failed and did not.
 * The local executor passes the driver source inline with `-c`/`-e`; the
 * sandbox executor writes it to a file and runs that, because E2B takes a
 * command string and shell-quoting a hundred lines of Python into one is a bug
 * farm. Those two put the sentinel in *different* argv positions:
 *
 *   node -e '<driver>' SENT   ->  [node, SENT]
 *   node /tmp/driver.js SENT  ->  [node, /tmp/driver.js, SENT]
 *
 * Everything else in the suite covers one launch style or a fake that never
 * runs the driver at all, so pinning the sentinel back to `argv[1]` passed all
 * of it — and would have shipped a sandboxed node repl where no frame ever
 * matches and every evaluation hangs until its two-minute timeout.
 *
 * Real interpreters, spawned for real, and the file form is the one that
 * matters. No sandbox is needed to prove it: the argv positions are the
 * interpreter's own behaviour, not E2B's.
 */

const written: string[] = [];

afterEach(async () => {
  for (const path of written.splice(0)) {
    await Bun.file(path)
      .unlink()
      .catch(() => {});
  }
});

/**
 * Runs one framed evaluation and returns what came back before the sentinel.
 *
 * Bounded: a driver that never frames its reply is the failure being tested
 * for, and it must show up as a failed expectation rather than a hung runner.
 */
async function evaluateOnce(
  language: ReplLanguage,
  code: string,
  launch: "inline" | "file",
): Promise<{ frame: string | null; sawSentinel: boolean }> {
  const driver = REPL_DRIVERS[language];
  const interpreter = driver.candidates
    .map((candidate) => Bun.which(candidate))
    .find((resolved): resolved is string => resolved !== null);
  if (!interpreter) return { frame: null, sawSentinel: false };

  const sentinel = `__woopcode_repl_${crypto.randomUUID()}__`;

  let args: string[];
  if (launch === "inline") {
    args = [...driver.leadingFlags, driver.inlineFlag, driver.source, sentinel];
  } else {
    // A UUID, not a timestamp: two runs at the same millisecond otherwise build
    // the same path and delete each other's file mid-test.
    const path = join(tmpdir(), `woopcode-driver-${crypto.randomUUID()}.${driver.extension}`);
    await Bun.write(path, driver.source);
    written.push(path);
    args = [...driver.leadingFlags, path, sentinel];
  }

  const proc = Bun.spawn({
    cmd: [interpreter, ...args],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    proc.stdin.write(`${JSON.stringify(code)}\n`);
    proc.stdin.flush();

    const decoder = new TextDecoder();
    const cursor = proc.stdout[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
    let seen = "";

    // Raced rather than iterated to a deadline. The failure this test exists to
    // catch is a driver that never emits a frame anyone is looking for, and
    // then the iterator simply never yields again — a deadline checked *after*
    // a chunk arrives is never reached, so the test hangs for its full timeout
    // instead of failing in a second.
    const expired = Bun.sleep(3000).then(() => "expired" as const);

    while (true) {
      const chunk = await Promise.race([cursor.next(), expired]);
      if (chunk === "expired" || chunk.done) break;

      seen += decoder.decode(chunk.value, { stream: true });
      if (seen.includes(sentinel)) {
        return { frame: seen.slice(0, seen.indexOf(sentinel)).trim(), sawSentinel: true };
      }
    }

    return { frame: seen.trim(), sawSentinel: false };
  } finally {
    try {
      proc.stdin.end();
    } catch {
      // Already gone; the kill covers it.
    }
    proc.kill();
    proc.unref();
  }
}

describe("the repl drivers frame their output whichever way they are launched", () => {
  for (const launch of ["inline", "file"] as const) {
    test(`python, launched ${launch}`, async () => {
      const { frame, sawSentinel } = await evaluateOnce("python", "6 * 7", launch);
      if (frame === null) return; // no interpreter on this machine

      expect(sawSentinel).toBe(true);
      expect(frame).toContain("42");
    }, 30_000);

    test(`node, launched ${launch}`, async () => {
      // The file case is the one the mutation survived. Without the sentinel
      // being read from the last argument it is the driver's own path here, no
      // frame is ever emitted that anyone is looking for, and `sawSentinel`
      // stays false.
      const { frame, sawSentinel } = await evaluateOnce("node", "6 * 7", launch);
      if (frame === null) return;

      expect(sawSentinel).toBe(true);
      expect(frame).toContain("42");
    }, 30_000);
  }

  test("a driver run from a file does not mistake its own path for the sentinel", async () => {
    // Stated on its own, because the assertion above could be satisfied by a
    // driver that happened to print the right number without framing.
    const { frame, sawSentinel } = await evaluateOnce("node", "'hello'", "file");
    if (frame === null) return;

    expect(sawSentinel).toBe(true);
    expect(frame).not.toContain(tmpdir());
  }, 30_000);
});
