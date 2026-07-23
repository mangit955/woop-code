import { Text } from "ink";

export interface HomeFooterProps {
  repository: string;
  branch: string;
  provider: string;
}

export function HomeFooter({ repository, branch, provider }: HomeFooterProps) {
  return <Text dimColor>{repository} · {branch} · {provider}</Text>;
}
