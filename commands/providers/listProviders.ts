import { Command } from "commander";
import { getConfig } from "../../config/config";
import { isProviderEnabled } from "../../config/providerRegistry";

export const listCommand = new Command("list")
  .description("Returns all the Providers with their default & auth status)")
  .option(
    "-p, --provider <providerName>",
    "Name of the provider (gemini, claude etc)",
    "",
  )
  .action(async () => {
    const config = await getConfig();

    const rows = Object.entries(config.providers).map(
      ([provider, details]: [string, any]) => {
        const loggedIn = !!details.apiKey;
        const isDefault = config.defaultProvider === provider;

        return {
          provider,
          status: loggedIn ? "Logged in" : "Not Logged in",
          supported: isProviderEnabled(provider) ? "✔︎" : "not yet",
          default: isDefault ? "✔︎" : "",
        };
      },
    );

    console.table(rows);
  });
