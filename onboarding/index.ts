import { render } from "ink";
import React from "react";
import { SetupWizard } from "./setupWizard";
import { getConfig } from "../config/config";

/**
 * Ensures a provider is configured. If not, launches the onboarding wizard.
 * This function is reusable across any command that requires authentication.
 *
 * @returns Promise that resolves when a provider is configured
 * @throws If the user cancels onboarding (Ctrl+C)
 */
export async function ensureProviderConfigured(): Promise<void> {
  const config = await getConfig();
  const provider = config.defaultProvider;
  const apiKey = config.providers[provider]?.apiKey;

  // Already configured
  if (provider && apiKey) {
    return;
  }

  // Launch onboarding
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
