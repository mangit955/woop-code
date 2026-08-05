import chalk from "chalk";
import type { Theme } from "cli-highlight";
import { colors } from "./theme";

/**
 * Syntax colours for code shown in the TUI — diff rows and fenced code blocks.
 *
 * cli-highlight defaults to the 16-colour ANSI palette, which renders as flat
 * primary red/green/blue and reads nothing like the rest of the interface.
 *
 * Every entry is a theme token, so highlighted code and the chrome around it are
 * one system. This file used to say that and not do it: it carried thirty of its
 * own hex literals on a third palette, One Dark's, which agreed with neither the
 * interface nor the markdown renderer it claimed to match.
 *
 * Six roles, drawn from the tokens: periwinkle for keywords, indigo for the
 * names of things, teal for built-ins and attributes, emerald for strings, amber
 * for literals, neutrals for everything else.
 */
export const syntaxTheme: Theme = {
  keyword: chalk.hex(colors.primary),
  built_in: chalk.hex(colors.accent),
  type: chalk.hex(colors.secondary),
  literal: chalk.hex(colors.warningBase),
  number: chalk.hex(colors.warningBase),
  regexp: chalk.hex(colors.successBase),
  string: chalk.hex(colors.successBase),
  subst: chalk.hex(colors.textBase),
  symbol: chalk.hex(colors.accent),
  class: chalk.hex(colors.secondary),
  function: chalk.hex(colors.secondary),
  title: chalk.hex(colors.secondary),
  params: chalk.hex(colors.textBase),
  comment: chalk.hex(colors.textFaint).italic,
  doctag: chalk.hex(colors.primary),
  meta: chalk.hex(colors.textMuted),
  "meta-keyword": chalk.hex(colors.primary),
  "meta-string": chalk.hex(colors.successBase),
  section: chalk.hex(colors.secondary).bold,
  tag: chalk.hex(colors.primary),
  name: chalk.hex(colors.secondary),
  attr: chalk.hex(colors.accent),
  attribute: chalk.hex(colors.accent),
  variable: chalk.hex(colors.textBase),
  bullet: chalk.hex(colors.primary),
  quote: chalk.hex(colors.borderStrong),
  link: chalk.hex(colors.accent).underline,
  emphasis: chalk.italic,
  strong: chalk.bold,
  addition: chalk.hex(colors.diffAdd),
  deletion: chalk.hex(colors.diffRemove),
  default: chalk.hex(colors.textBase),
};
