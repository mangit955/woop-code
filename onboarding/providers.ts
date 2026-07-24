// Provider registry for onboarding
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
    enabled: false,
    keyUrl: "https://platform.openai.com/api-keys",
    description: "GPT-4 and GPT-3.5 models",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    enabled: false,
    keyUrl: "https://console.anthropic.com/settings/keys",
    description: "Claude 3 family of models",
  },
  {
    id: "groq",
    name: "Groq",
    enabled: false,
    keyUrl: "https://console.groq.com/keys",
    description: "Ultra-fast inference for open models",
  },
];

export function getEnabledProviders(): ProviderInfo[] {
  return PROVIDERS.filter((p) => p.enabled);
}

export function getProviderInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
