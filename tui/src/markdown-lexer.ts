import { Marked, type Token } from "marked";

/**
 * Markdown lexer tuned for a coding agent's output.
 *
 * CommonMark reads `__tests__` as bold "tests" and `_private_` as italic
 * "private", so a path like `__tests__/auth-login.test.ts` rendered as
 * `tests/auth-login.test.ts` — the underscores were silently eaten. Assistant
 * text is full of dunder and leading-underscore identifiers, and they are almost
 * never emphasis.
 *
 * So underscore emphasis is off; `*em*` and `**bold**` still work, which is what
 * models reach for anyway. Intraword underscores (`some_var_name`) were already
 * safe — CommonMark forbids emphasis there — this closes the case where the
 * underscores sit at the edges of a word.
 */
const LITERAL_UNDERSCORES = "literalUnderscores";

const lexerInstance = new Marked();

lexerInstance.use({
  extensions: [
    {
      // An inline extension rather than an emStrong override: extensions are
      // consulted before the built-in tokenizers, so claiming the underscore run
      // here keeps it out of emphasis without touching how `*` is parsed.
      name: LITERAL_UNDERSCORES,
      level: "inline",
      // Tells the lexer where the next candidate is, so plain text does not
      // swallow the run before this extension is offered it.
      start: (src: string) => src.indexOf("_"),
      tokenizer(src: string) {
        const underscores = /^_+/.exec(src);
        if (!underscores) return undefined;

        return { type: LITERAL_UNDERSCORES, raw: underscores[0], text: underscores[0] };
      },
    },
  ],
});

export function lexMarkdown(text: string): Token[] {
  return lexerInstance.lexer(text);
}
