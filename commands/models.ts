import { Command } from "commander";
import models from "../config/models.json";

export const modelsCommand = new Command("models")
  .description("Returns all the supported models")
  .option("-m, --model <modelName>", "name of the model", "all")
  .action((options) => {
    if (options.model === "all") {
      console.table(models);
      return;
    }

    const model = models.find((m) => m.id === options.model);

    if (!model) {
      console.error(`Model "${options.model}" not found.`);
      return;
    }
    console.table([model]);
    console.log(options);
  });
