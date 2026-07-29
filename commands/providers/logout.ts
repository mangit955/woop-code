import { Command } from "commander";
import { getConfig, saveConfig } from "../../config/config";
import { isProviderEnabled } from "../../config/providerRegistry";

export const logoutCommand = new Command("logout")
  .description("Lets user logout from the provider")
  .option(
    "-p, --provider <providerName>",
    "Name of the provider (gemini, claude etc)",
    "",
  )
  .action(async (options) => {
    const config = await getConfig();
    const providerConfig = config.providers[options.provider];

    if (!providerConfig) {
      console.error(`Unknown Provider ${options.provider}`);
      return;
    }

    if (!providerConfig.apiKey) {
      console.error(`${options.provider} is not logged in`);
      return;
    }

    delete providerConfig.apiKey;

    // Logging out of the active provider must not leave it selected, or the
    // next run picks a provider with no API key. Fall back to another
    // logged-in provider when there is one, matching the /logout slash command.
    if (config.defaultProvider === options.provider) {
      const fallback = Object.entries(config.providers).find(
        ([name, details]: [string, any]) =>
          name !== options.provider && details?.apiKey && isProviderEnabled(name),
      );

      config.defaultProvider = fallback ? fallback[0] : "";
    }

    await saveConfig(config);

    console.log("logging out for provider " + options.provider);
    console.log(
      config.defaultProvider
        ? `Active provider: ${config.defaultProvider}`
        : "No providers logged in. Use 'woopcode providers login' to authenticate.",
    );
  });
