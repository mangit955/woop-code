#!/usr/bin/env bun
/**
 * Utility script to reset provider configuration for testing onboarding.
 * 
 * Usage:
 *   bun onboarding/test-reset.ts           # Clear all API keys
 *   bun onboarding/test-reset.ts restore   # Restore from backup
 */

import { existsSync } from "fs";

const CONFIG_PATH = "./config/providers.json";
const BACKUP_PATH = "./config/providers.json.backup";

const command = process.argv[2];

async function clearKeys() {
  // Backup current config
  if (existsSync(CONFIG_PATH)) {
    const current = await Bun.file(CONFIG_PATH).text();
    await Bun.write(BACKUP_PATH, current);
    console.log("✓ Backed up current configuration");
  }

  // Clear all API keys
  const config = JSON.parse(await Bun.file(CONFIG_PATH).text());
  
  for (const provider in config.providers) {
    config.providers[provider].apiKey = "";
  }

  await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log("✓ Cleared all API keys");
  console.log("\nYou can now test the onboarding flow:");
  console.log("  bun cli.ts");
  console.log("\nTo restore your keys:");
  console.log("  bun onboarding/test-reset.ts restore");
}

async function restore() {
  if (!existsSync(BACKUP_PATH)) {
    console.error("✖ No backup found");
    process.exit(1);
  }

  const backup = await Bun.file(BACKUP_PATH).text();
  await Bun.write(CONFIG_PATH, backup);
  console.log("✓ Restored configuration from backup");
}

if (command === "restore") {
  await restore();
} else {
  await clearKeys();
}
