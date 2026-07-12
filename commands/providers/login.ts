import { Command } from "commander";
import { loginProvider } from "../../config/authProvider";
import { getConfig, saveConfig } from "../../config/config";

export const loginCommand = new Command("login")
  .description("Lets user login into the provider (use it as default)")
  .option(
    "-p, --provider <providerName>",
    "Name of the provider (gemini, claude etc)",
    "",
  )
  .option("-a, --api-key <apiKey>", "Your api key", "")
  .action(async (options) => {
    const success = await loginProvider(options.provider, options.apiKey);

    if (!success) {
      console.error(" Invalid API key");
      process.exit(1);
    }

    const config = await getConfig();

    config.defaultProvider = options.provider;
    config.providers[options.provider].apiKey = options.apiKey;
    await saveConfig(config);

    console.log("logging into " + options.provider);
  });
