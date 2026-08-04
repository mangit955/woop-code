/**
 * The models Woopcode knows about, and what can be said about each one.
 *
 * `models.json` is a list of facts about models. Whether a model can actually
 * run is a fact about its *provider*, and `providerRegistry.ts` already owns
 * that. So nothing here records a model's availability — it is derived on every
 * read by joining the two. Enabling a provider is one edit in the registry, and
 * every surface that mentions its models moves with it.
 *
 * The alternative — a `"supported": false` beside each row — is a second source
 * of truth, and the day a provider ships is the day the two disagree.
 */

import catalog from "./models.json";
import { getProviderInfo, isProviderEnabled } from "./providerRegistry";

export interface Model {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  /** Tokens. A number, always: it is a quantity, not a label. */
  readonly contextWindow: number;
}

/**
 * What a row says about itself, before it is worded for a human.
 *
 * `default` outranks `ready` because a user scanning this list is usually
 * answering "which one am I on", and only one row can answer it.
 */
export type ModelStatus = "default" | "ready" | "coming-soon";

const models = catalog as Model[];

/**
 * The model a turn uses when nothing has been selected.
 *
 * Defined here rather than in client.ts, and re-exported from there, so that
 * "which model does this provider start on" has one answer in the module that
 * already owns the catalog. The alternative put the Google default beside the
 * Gemini client and left every other provider's default to be invented at the
 * call site.
 */
export const DEFAULT_MODEL_ID = "gemini-3.5-flash-lite";

/**
 * Each provider's starting model, where that is a judgement rather than a fact
 * about the catalog.
 *
 * Not simply "the provider's first row": the rows are ordered for reading, most
 * capable first, and the default is a different question — cost and latency
 * matter as much as capability for a model that runs on every turn until
 * someone chooses otherwise.
 */
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  google: DEFAULT_MODEL_ID,
  gemini: DEFAULT_MODEL_ID,
  anthropic: "claude-opus-5",
  openai: "gpt-5.5",
};

export function allModels(): Model[] {
  return models;
}

/**
 * The model to run for a provider when the current selection is not its own.
 *
 * A config written before a provider existed — or by hand — can pair a provider
 * with another provider's model, and sending a Gemini id to Anthropic is a 404
 * on the first turn. Falls back to any row belonging to the provider, then to
 * the global default, so this always answers.
 */
export function defaultModelForProvider(provider: string): string {
  const preferred = PROVIDER_DEFAULT_MODELS[provider];
  if (preferred && findModel(preferred)) return preferred;

  return models.find((model) => model.provider === provider)?.id ?? DEFAULT_MODEL_ID;
}

/**
 * Whether this model can be run by this provider.
 *
 * "gemini" is accepted as an alias for "google" the same way the registry
 * accepts it, so an aliased provider does not look like a mismatch.
 */
export function modelBelongsToProvider(modelId: string | undefined, provider: string): boolean {
  const model = modelId ? findModel(modelId) : undefined;
  if (!model) return false;

  const canonical = provider === "gemini" ? "google" : provider;
  return model.provider === canonical;
}

/** Exact id, for resolving a selection. */
export function findModel(id: string): Model | undefined {
  return models.find((model) => model.id === id);
}

/**
 * Every model matching a free-text query, by id or display name.
 *
 * A filter rather than a lookup: `gemini` is a reasonable thing to type and
 * means "show me those", not "no such model". An exact id still resolves to
 * exactly itself, so the narrow case is unaffected.
 */
export function findModels(query: string): Model[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return models;

  const exact = findModel(needle);
  if (exact) return [exact];

  return models.filter(
    (model) =>
      model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
  );
}

/** Whether a turn using this model would reach a provider client at all. */
export function isRunnable(model: Model): boolean {
  return isProviderEnabled(model.provider);
}

export function modelStatus(model: Model, activeModelId?: string): ModelStatus {
  if (!isRunnable(model)) return "coming-soon";
  return model.id === activeModelId ? "default" : "ready";
}

/**
 * Status as a user should read it.
 *
 * "Coming Soon" rather than "not supported": the provider is planned and
 * deliberately listed, and describing that as a missing feature reads as an
 * unfinished product rather than an intentional roadmap.
 */
export function describeStatus(status: ModelStatus): string {
  switch (status) {
    case "default":
      return "Default";
    case "ready":
      return "Ready";
    case "coming-soon":
      return "Coming Soon";
  }
}

/** The provider's display name, from the registry that owns it. */
export function providerLabel(provider: string): string {
  return getProviderInfo(provider)?.name ?? provider;
}

/** `1000000` reads as `1M`: the exact token count is never the question here. */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimZero(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trimZero(tokens / 1_000)}K`;
  return String(tokens);
}

function trimZero(value: number): string {
  return Number(value.toFixed(1)).toString();
}
