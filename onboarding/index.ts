import { render } from "ink";
import React from "react";
import { SetupWizard } from "./setupWizard";
import { getConfig } from "../config/config";
import { isProviderEnabled } from "../config/providerRegistry";
import {
  canPromptInteractively,
  resolveEnvCredentials,
} from "../config/envCredentials";

export interface ProviderCredentials {
  provider: string;
  apiKey: string;
}

/**
 * Resolves the active provider and its key, or null when the config cannot
 * currently run: no default provider, a missing or keyless provider entry, or
 * a provider Woopcode has no client for.
 */
export async function resolveCredentials(): Promise<ProviderCredentials | null> {
  const config = await getConfig();
  const provider = config.defaultProvider;
  const apiKey = config.providers[provider]?.apiKey;

  if (!provider || !apiKey || !isProviderEnabled(provider)) {
    return null;
  }

  return { provider, apiKey };
}

/**
 * Ensures a provider is configured, launching the onboarding wizard when it is
 * not, and returns the credentials the caller should run with. Callers use the
 * return value instead of re-reading the config, so there is a single place
 * that decides whether a config is usable.
 *
 * @throws If onboarding completes without usable credentials (Ctrl+C exits).
 */
export async function ensureProviderConfigured(): Promise<ProviderCredentials> {
  // The environment wins over stored config. An automated caller that exports
  // a key is stating which credentials this process should use, and a stale
  // key left in the config directory must not silently take precedence.
  const fromEnv = resolveEnvCredentials();
  if (fromEnv) {
    return { provider: fromEnv.provider, apiKey: fromEnv.apiKey };
  }

  // Already configured. A provider that can no longer run (a key stored by an
  // older version) counts as unconfigured, so the wizard offers a working one
  // instead of letting the first turn fail.
  const existing = await resolveCredentials();
  if (existing) {
    return existing;
  }

  // The wizard needs a terminal. Without one it would block on input that can
  // never arrive, so an unconfigured non-interactive run must fail with a
  // message that names the fix rather than hanging until the caller's timeout.
  if (!canPromptInteractively()) {
    throw new Error(
      "No provider is configured and there is no terminal to run setup in.\n" +
        "Set GEMINI_API_KEY (or WOOPCODE_API_KEY with WOOPCODE_PROVIDER) in the environment.",
    );
  }

  await runOnboarding();

  const credentials = await resolveCredentials();
  if (!credentials) {
    throw new Error(
      "Setup did not produce a usable provider. Run 'woopcode providers login -p google -a <api-key>' and try again.",
    );
  }

  return credentials;
}

function runOnboarding(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let hasCompleted = false;

    const { unmount, waitUntilExit } = render(
      React.createElement(SetupWizard, {
        onComplete: () => {
          hasCompleted = true;
          unmount();
          resolve();
        },
        onError: (error: string) => {
          console.error(`\n✖ ${error}\n`);
          // Don't unmount - let user try again
        },
      }),
    );

    // Handle Ctrl+C gracefully
    const handleExit = () => {
      if (!hasCompleted) {
        unmount();
        console.log("\n\nSetup cancelled. Run 'woopcode' again when you're ready.\n");
        process.exit(0);
      }
    };

    process.once("SIGINT", handleExit);

    waitUntilExit().then(() => {
      process.off("SIGINT", handleExit);
    });
  });
}
