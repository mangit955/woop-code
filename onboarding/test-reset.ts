#!/usr/bin/env bun
/**
 * Puts the machine back into the state a new user starts from, so the setup
 * wizard can be walked without uninstalling anything.
 *
 *   bun onboarding/test-reset.ts           # move the config directory aside
 *   bun onboarding/test-reset.ts restore   # put it back
 *
 * The whole directory moves, rather than the keys being blanked in place.
 * `ensureProviderConfigured` treats a keyless provider and a missing config the
 * same way, but the rest of a first run does not: conversation.json and
 * execution-log.json are what separate "no key yet" from "never run before",
 * and blanking a key leaves both behind.
 *
 * This previously pointed at ./config/providers.json — a path inside the
 * repository, where no configuration has ever lived. It raised ENOENT on every
 * invocation, which is why it never reset anything. `getConfigDir` is imported
 * rather than rebuilt so the two cannot drift apart again.
 */

import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config/paths";

// getConfigDir creates the directory as a side effect, which is harmless here:
// an empty directory moved aside is the same cold start as a missing one.
const CONFIG_DIR = getConfigDir();
const BACKUP_DIR = join(dirname(CONFIG_DIR), "woopcode.pre-onboarding-test");

function reset() {
  if (existsSync(BACKUP_DIR)) {
    console.error(`✖ A backup is already sitting at ${BACKUP_DIR}`);
    console.error("  Restore it first, or delete it if you no longer want it.");
    process.exit(1);
  }

  renameSync(CONFIG_DIR, BACKUP_DIR);

  console.log(`✓ Moved ${CONFIG_DIR}`);
  console.log(`  to     ${BACKUP_DIR}`);
  console.log("\nWalk the setup wizard:");
  console.log("  bun cli.ts");
  console.log("\nThen put your real configuration back:");
  console.log("  bun onboarding/test-reset.ts restore");
}

function restore() {
  if (!existsSync(BACKUP_DIR)) {
    console.error(`✖ No backup at ${BACKUP_DIR}`);
    process.exit(1);
  }

  // Whatever the wizard just wrote is test data, and the backup is the real
  // configuration. Removing it first keeps rename from failing on a directory
  // that already exists.
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  renameSync(BACKUP_DIR, CONFIG_DIR);

  console.log(`✓ Restored ${CONFIG_DIR}`);
}

if (process.argv[2] === "restore") {
  restore();
} else {
  reset();
}
