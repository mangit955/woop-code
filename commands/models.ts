import { Command } from "commander";
import { DEFAULT_MODEL_ID } from "../config/client";
import { getConfig } from "../config/config";
import {
  allModels,
  describeStatus,
  findModels,
  formatContextWindow,
  modelStatus,
  providerLabel,
  type Model,
} from "../config/modelCatalog";
import { renderTable } from "./table";

/** Marks the row a turn would use right now, so the table answers "which am I on". */
const ACTIVE_MARKER = "●";

export const modelsCommand = new Command("models")
  .description("List the available models and their status")
  .option("-m, --model <query>", "show only models matching a name or id")
  .action(async (options: { model?: string }) => {
    const config = await getConfig();
    const activeModelId = config.selectedModel ?? DEFAULT_MODEL_ID;

    const query = options.model ?? "";
    const matches = query === "" ? allModels() : findModels(query);

    if (matches.length === 0) {
      // A dead end helps nobody: show what the query was close to.
      console.error(`No models match "${query}".`);

      const nearby = suggestions(query);
      if (nearby.length > 0) {
        console.error("\nDid you mean:");
        for (const model of nearby) {
          console.error(`  ${model.id} — ${model.name} (${providerLabel(model.provider)})`);
        }
      }

      console.error("\nRun `woopcode models` to see every model.");
      process.exitCode = 1;
      return;
    }

    console.log(renderTable(matches, columns(activeModelId)));
  });

function columns(activeModelId: string) {
  return [
    {
      header: "  Model",
      value: (model: Model) =>
        `${model.id === activeModelId ? ACTIVE_MARKER : " "} ${model.id}`,
    },
    { header: "Provider", value: (model: Model) => providerLabel(model.provider) },
    {
      header: "Context",
      value: (model: Model) => formatContextWindow(model.contextWindow),
      align: "right" as const,
    },
    {
      header: "Status",
      value: (model: Model) => describeStatus(modelStatus(model, activeModelId)),
    },
  ];
}

/**
 * Models sharing a leading fragment with the query. `gpt-6` finds `gpt-5.5`;
 * a query with nothing in common finds nothing rather than a random list.
 */
function suggestions(query: string): Model[] {
  const needle = query.trim().toLowerCase();

  for (let length = needle.length - 1; length >= 2; length--) {
    const nearby = findModels(needle.slice(0, length));
    if (nearby.length > 0 && nearby.length < allModels().length) return nearby.slice(0, 5);
  }

  return [];
}
