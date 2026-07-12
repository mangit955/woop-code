import { Command } from "commander";
import { getConfig, saveConfig } from "../../config/config";

export const logoutCommand = new Command("logout")
  .description("Lets user logout from the provider")
  .option(
    "-p, --provider <providerName>",
    "Name of the provider (gemini, claude etc)",
    "",
  )
  .action(async (options) => {
    const config = await getConfig();

    if (!config.providers[options.provider]) {
      console.error(`Unknown Provider ${options.provider}`);
      return;
    }

    if (!config.providers[options.provider].apiKey) {
      console.error(`${options.provider} is not logged in`);
      return;
    }

    delete config.providers[options.provider].apiKey;

    if (config.defaultProvider === options.provider) {
      config.defaultProviders === "";
    }

    await saveConfig(config);

    console.log("logging out for provider " + options.provider);
  });
