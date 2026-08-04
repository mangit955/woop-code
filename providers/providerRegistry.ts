/**
 * The single source of truth for which providers Woopcode can actually run.
 *
 * `enabled` means `createProviderClient` has a client for it. Anything listed
 * with `enabled: false` is a planned provider: it is shown so users know it is
 * coming, but login, provider selection and onboarding all refuse it rather
 * than letting a key be stored for a provider that throws on the first turn.
 */
export interface ProviderInfo {
  id: string;
  name: string;
  enabled: boolean;
  keyUrl: string;
  description: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "google",
    name: "Google Gemini",
    enabled: true,
    keyUrl: "https://aistudio.google.com/apikey",
    description: "Fast and capable, with a generous free tier",
  },
  {
    id: "openai",
    name: "OpenAI",
    enabled: true,
    keyUrl: "https://platform.openai.com/api-keys",
    description: "GPT models, with reasoning effort you can dial down",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    enabled: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
    description: "Claude models, strongest on long agentic work",
  },
];

export function getEnabledProviders(): ProviderInfo[] {
  return PROVIDERS.filter((provider) => provider.enabled);
}

export function getProviderInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

export function isProviderEnabled(id: string): boolean {
  // "gemini" is accepted as an alias for "google" by createProviderClient.
  if (id === "gemini") return true;
  return getProviderInfo(id)?.enabled ?? false;
}

export function enabledProviderIds(): string[] {
  return getEnabledProviders().map((provider) => provider.id);
}

/** Explains why a configured-but-unrunnable provider was refused. */
export function unsupportedProviderMessage(id: string): string {
  const known = getProviderInfo(id);
  const supported = enabledProviderIds().join(", ");

  return known
    ? `Provider "${id}" is not supported yet — Woopcode has no runtime client for it.\nSupported: ${supported}`
    : `Unknown provider "${id}".\nSupported: ${supported}`;
}
