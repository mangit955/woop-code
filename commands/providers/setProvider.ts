import { Command } from "commander";
import { getConfig, saveConfig } from "../../config/config";

export const setProviderCommand = new Command("set")
  .description("Lets user set the default provider")
  .option(
    "-p, --provider <providerName>",
    "Name of the provider (gemini, claude etc)",
    "",
  )
  .action(async (options) => {
    const config = await getConfig();
    console.log("provider is  " + JSON.stringify(options));

    if (!config.providers[options.provider]) {
      console.error(`${options.provider} does not exist`);
      return;
    }

    if (!config.providers[options.provider].apiKey) {
      console.error(`${options.provider} is not logged in`);
      return;
    }

    if (config.defaultProvider === options.provider) {
      console.log(`${options.provider} is already default provider`);
      return;
    }

    config.defaultProvider = options.provider;

    await saveConfig(config);
    console.log(`Default provider set to ${options.provider}`);
  });
