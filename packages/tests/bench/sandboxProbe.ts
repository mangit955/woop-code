/**
 * Follow-up to sandboxOverhead.ts, for the three results that were ambiguous:
 * which env vars actually exist inside a sandbox, whether the link-local
 * metadata endpoint is really reachable, and what the 80MB workspace is made
 * of. Each was reported as a count or a status code, which is not enough to
 * act on.
 */

import { Sandbox } from "e2b";
import path from "node:path";
import { stat } from "node:fs/promises";

async function main() {
  // ---- what is actually large in the transmittable set ----
  const listed = Bun.spawnSync({
    cmd: ["git", "ls-files", "-co", "--exclude-standard"],
    stdout: "pipe",
  });
  const files = new TextDecoder().decode(listed.stdout).split("\n").filter(Boolean);

  const sized: { file: string; size: number }[] = [];
  for (const file of files) {
    try {
      sized.push({ file, size: (await stat(path.join(process.cwd(), file))).size });
    } catch {}
  }
  sized.sort((a, b) => b.size - a.size);

  const total = sized.reduce((sum, entry) => sum + entry.size, 0);
  console.log(`\nworkspace: ${sized.length} files, ${(total / 1_048_576).toFixed(1)}MB\n`);
  console.log("largest 12:");
  for (const entry of sized.slice(0, 12)) {
    console.log(`  ${(entry.size / 1_048_576).toFixed(2).padStart(7)}MB  ${entry.file}`);
  }

  const over1MB = sized.filter((entry) => entry.size > 1_048_576);
  const over1MBBytes = over1MB.reduce((sum, entry) => sum + entry.size, 0);
  console.log(
    `\n  files >1MB: ${over1MB.length} (${(over1MBBytes / 1_048_576).toFixed(1)}MB, ` +
      `${((over1MBBytes / total) * 100).toFixed(0)}% of the total)`,
  );

  const sandbox = await Sandbox.create({ timeoutMs: 3 * 60_000 });
  console.log(`\nsandbox ${sandbox.sandboxId}\n`);

  try {
    // ---- exactly which env vars are present ----
    const env = await sandbox.commands.run("env | sort");
    const names = env.stdout
      .split("\n")
      .map((line) => line.split("=")[0])
      .filter(Boolean);
    console.log(`env vars inside sandbox (${names.length}):`);
    console.log(`  ${names.join(" ")}`);

    const matched = env.stdout
      .split("\n")
      .filter((line) => /WOOPCODE|ANTHROPIC|OPENAI|GEMINI|E2B/i.test(line));
    console.log(`\nlines matching the credential grep (${matched.length}):`);
    for (const line of matched) {
      const [name, ...rest] = line.split("=");
      const value = rest.join("=");
      // Never print a value that might be a real key; length and prefix is
      // enough to tell a sandbox id from a leaked credential.
      console.log(
        `  ${name} = ${value.slice(0, 12)}${value.length > 12 ? "…" : ""} (${value.length} chars)`,
      );
    }

    // Does the host's actual key appear anywhere?
    const hostKey = process.env.E2B_API_KEY ?? "";
    const providerKey = process.env.WOOPCODE_API_KEY ?? "";
    console.log(
      `\n  host E2B_API_KEY present verbatim in sandbox env: ` +
        `${hostKey.length > 0 && env.stdout.includes(hostKey)}`,
    );
    console.log(
      `  host WOOPCODE_API_KEY present verbatim in sandbox env: ` +
        `${providerKey.length > 0 && env.stdout.includes(providerKey)}`,
    );

    // ---- link-local / metadata reachability, in detail ----
    console.log("\nnetwork reachability:");
    for (const target of [
      "http://169.254.169.254/",
      "http://169.254.169.254/computeMetadata/v1/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://127.0.0.1:22/",
    ]) {
      const probe = await sandbox.commands.run(
        `curl -s -m 4 -o /dev/null -w '%{http_code} %{time_total}s' '${target}' || echo " (curl exit $?)"`,
      );
      console.log(`  ${target.padEnd(46)} ${probe.stdout.trim()}`);
    }

    const body = await sandbox.commands.run(
      "curl -s -m 4 http://169.254.169.254/ | head -c 300 || true",
    );
    console.log(`\n  body of 169.254.169.254:\n    ${body.stdout.trim().replace(/\n/g, "\n    ")}`);

    // ---- what the base template actually has ----
    console.log("\ntoolchain in base template:");
    const which = await sandbox.commands.run(
      "for t in bun node npm python3 git gcc make curl tar; do " +
        'printf "%-8s %s\\n" "$t" "$(command -v $t || echo MISSING)"; done',
    );
    console.log(which.stdout.trimEnd().split("\n").map((l) => `  ${l}`).join("\n"));
  } finally {
    await sandbox.kill();
    console.log("\nsandbox killed");
  }
}

await main();
