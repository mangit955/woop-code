export interface ProviderClient {
  generate(message: Message[]): Promise<string>;
}

export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};
