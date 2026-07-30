import type { ProvidersConfig } from "../../config/config";

/**
 * Switching models touches three things that can disagree: the config file, the
 * controller's in-memory model, and the UI. The picker used to change the
 * controller first and then persist, with the whole sequence fire-and-forget —
 * so a failed write left the session running a model the file did not record,
 * the picker open, and nothing on screen to say why.
 *
 * The order here is deliberate: persist first, then apply. A failed write then
 * changes nothing at all, which is a state the user can retry from.
 */
export type ModelSelectionOutcome =
  | { status: "applied" }
  /** Nothing was written or changed. */
  | { status: "refused"; message: string }
  /** Something went wrong; the message is for the user. */
  | { status: "failed"; message: string };

export interface ModelSelectionDeps {
  modelId: string;
  isBusy: () => boolean;
  /** Returns false when the model could not be swapped, e.g. a turn started. */
  setModel: (modelId: string) => boolean;
  loadConfig: () => Promise<ProvidersConfig>;
  saveConfig: (config: ProvidersConfig) => Promise<void>;
  /** Records the choice in the UI and closes the picker. */
  commit: (modelId: string) => void;
}

export async function applyModelSelection({
  modelId,
  isBusy,
  setModel,
  loadConfig,
  saveConfig,
  commit,
}: ModelSelectionDeps): Promise<ModelSelectionOutcome> {
  // Checked before anything is written. The controller refuses to swap models
  // mid-turn, and a config file that disagrees with the running session is a
  // worse outcome than declining the change and saying so.
  if (isBusy()) {
    return {
      status: "refused",
      message: "Cannot switch model while a request is running.",
    };
  }

  try {
    const config = await loadConfig();
    config.selectedModel = modelId;
    await saveConfig(config);
  } catch (cause) {
    // Nothing has changed: the session keeps the model it already had.
    return {
      status: "failed",
      message: `Could not save the model selection: ${describe(cause)}`,
    };
  }

  if (!setModel(modelId)) {
    // Narrow window: a turn began while the config was being written. The
    // choice is on disk, so say what will and will not happen rather than
    // reporting a plain failure.
    return {
      status: "failed",
      message: "Saved, but a request started before the switch applied. It takes effect next session.",
    };
  }

  commit(modelId);
  return { status: "applied" };
}

function describe(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
