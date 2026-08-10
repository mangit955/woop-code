import { Command } from "commander";
import { loginProvider } from "../../config/authProvider";
import { apiProviderEntry, getConfig, saveConfig } from "../../config/config";
import {
  isProviderEnabled,
  unsupportedProviderMessage,
} from "../../providers/providerRegistry";

export const loginCommand = new Command("login")
  .description("Lets user login into the provider (use it as default)")
  .option(
    "-p, --provider <providerName>",
    "Name of the provider (gemini, claude etc)",
    "",
  )
  .option("-a, --api-key <apiKey>", "Your api key", "")
  .action(async (options) => {
    if (!isProviderEnabled(options.provider)) {
      console.error(unsupportedProviderMessage(options.provider));
      process.exit(1);
    }

    const success = await loginProvider(options.provider, options.apiKey);

    if (!success) {
      console.error(" Invalid API key");
      process.exit(1);
    }

    const config = await getConfig();

    config.defaultProvider = options.provider;
    // Built fresh rather than spread over the previous entry: that entry may
    // be a demo one, whose proxy URL would otherwise survive underneath a real
    // key. It also covers an entry that is absent entirely, in a config
    // written by an older version or trimmed by hand.
    config.providers[options.provider] = apiProviderEntry(options.apiKey);
    await saveConfig(config);

    console.log("logging into " + options.provider);
  });
