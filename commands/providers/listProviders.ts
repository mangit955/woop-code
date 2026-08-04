import { Command } from "commander";
import { getConfig } from "../../config/config";
import { isProviderEnabled } from "../../providers/providerRegistry";
import { renderTable } from "../table";

interface ProviderRow {
  provider: string;
  loggedIn: boolean;
  isDefault: boolean;
}

export const listCommand = new Command("list")
  .description("List the configured providers with their auth and default status")
  .option(
    "-p, --provider <providerName>",
    "Name of the provider (gemini, claude etc)",
    "",
  )
  .action(async () => {
    const config = await getConfig();

    const rows: ProviderRow[] = Object.entries(config.providers).map(
      ([provider, details]: [string, any]) => ({
        provider,
        loggedIn: !!details.apiKey,
        isDefault: config.defaultProvider === provider,
      }),
    );

    if (rows.length === 0) {
      console.log("No providers configured. Run `woopcode providers login` to add one.");
      return;
    }

    // Same wording as `models`: a planned provider is on the roadmap, not broken.
    console.log(
      renderTable(rows, [
        { header: "  Provider", value: (row) => `${row.isDefault ? "●" : " "} ${row.provider}` },
        { header: "Auth", value: (row) => (row.loggedIn ? "Logged in" : "Not logged in") },
        {
          header: "Status",
          value: (row) => (isProviderEnabled(row.provider) ? "Ready" : "Coming Soon"),
        },
      ]),
    );
  });
