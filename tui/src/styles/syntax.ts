import chalk from "chalk";
import type { Theme } from "cli-highlight";

/**
 * Syntax colours for code shown in the TUI — diff rows and fenced code blocks.
 *
 * cli-highlight defaults to the 16-colour ANSI palette, which renders as flat
 * primary red/green/blue and reads nothing like the rest of the interface. These
 * are the same hues the markdown renderer already uses, so highlighted code and
 * prose belong to one palette.
 */
export const syntaxTheme: Theme = {
  keyword: chalk.hex("#9d7cd8"),
  built_in: chalk.hex("#56b6c2"),
  type: chalk.hex("#e5c07b"),
  literal: chalk.hex("#d19a66"),
  number: chalk.hex("#d19a66"),
  regexp: chalk.hex("#7fd88f"),
  string: chalk.hex("#7fd88f"),
  subst: chalk.hex("#e5e5e5"),
  symbol: chalk.hex("#56b6c2"),
  class: chalk.hex("#e5c07b"),
  function: chalk.hex("#61afef"),
  title: chalk.hex("#61afef"),
  params: chalk.hex("#e5e5e5"),
  comment: chalk.hex("#6b7280").italic,
  doctag: chalk.hex("#9d7cd8"),
  meta: chalk.hex("#a3a3a3"),
  "meta-keyword": chalk.hex("#9d7cd8"),
  "meta-string": chalk.hex("#7fd88f"),
  section: chalk.hex("#61afef").bold,
  tag: chalk.hex("#9d7cd8"),
  name: chalk.hex("#61afef"),
  attr: chalk.hex("#56b6c2"),
  attribute: chalk.hex("#56b6c2"),
  variable: chalk.hex("#e5e5e5"),
  bullet: chalk.hex("#fab283"),
  quote: chalk.hex("#e5c07b"),
  link: chalk.hex("#56b6c2").underline,
  emphasis: chalk.italic,
  strong: chalk.bold,
  addition: chalk.hex("#7dd3fc"),
  deletion: chalk.hex("#f0a6bb"),
  default: chalk.hex("#e5e5e5"),
};
