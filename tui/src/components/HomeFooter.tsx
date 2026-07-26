import { Text } from "ink";
import { colors } from "../styles/theme";

export interface HomeFooterProps {
  repository: string;
  branch: string;
  provider: string;
}

export function HomeFooter({ repository, branch, provider }: HomeFooterProps) {
  return <Text color={colors.textMuted}>{repository} · {branch} · {provider}</Text>;
}
