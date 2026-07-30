import { describe, expect, test } from "bun:test";
import { lexMarkdown } from "./markdown-lexer";

/** The inline text of the first paragraph, reassembled from its tokens. */
function inlineText(markdown: string) {
  const [paragraph] = lexMarkdown(markdown) as Array<{
    tokens?: Array<{ raw: string }>;
  }>;

  return (paragraph?.tokens ?? []).map((token) => token.raw).join("");
}

/** The inline token types of the first paragraph. */
function inlineTypes(markdown: string) {
  const [paragraph] = lexMarkdown(markdown) as Array<{
    tokens?: Array<{ type: string }>;
  }>;

  return (paragraph?.tokens ?? []).map((token) => token.type);
}

describe("underscores in prose", () => {
  test("keeps a dunder path intact", () => {
    // The reported bug: this rendered as "tests/auth-login.test.ts", because
    // CommonMark reads __tests__ as bold and drops the underscores.
    const line = "__tests__/auth-login.test.ts contains both login and signup tests.";

    expect(inlineText(line)).toBe(line);
    expect(inlineTypes(line)).not.toContain("strong");
  });

  test("keeps a leading-underscore identifier intact", () => {
    const line = "Renamed _private_ to __internal__ today.";

    expect(inlineText(line)).toBe(line);
    expect(inlineTypes(line)).not.toContain("em");
    expect(inlineTypes(line)).not.toContain("strong");
  });

  test("leaves intraword underscores alone, as it always did", () => {
    const line = "some_var_name and another_one_here";

    expect(inlineText(line)).toBe(line);
  });

  test("survives an unbalanced run", () => {
    const line = "a stray __ underscore run _ here";

    expect(inlineText(line)).toBe(line);
  });
});

describe("asterisk emphasis still works", () => {
  test("bold and italic parse as before", () => {
    expect(inlineTypes("**bold** text")).toContain("strong");
    expect(inlineTypes("*italic* text")).toContain("em");
  });

  test("keeps marked's own nesting for combined emphasis", () => {
    // Unchanged behaviour: marked wraps *** in em with strong inside.
    const [paragraph] = lexMarkdown("***both*** text") as Array<{
      tokens?: Array<{ type: string; tokens?: Array<{ type: string }> }>;
    }>;

    expect(paragraph?.tokens?.[0]?.type).toBe("em");
    expect(paragraph?.tokens?.[0]?.tokens?.[0]?.type).toBe("strong");
  });

  test("emphasis around an underscored name still emphasises", () => {
    // The asterisks are the delimiters; the underscores are part of the name.
    const types = inlineTypes("**__tests__/auth.ts**");

    expect(types).toContain("strong");
    expect(inlineText("**__tests__/auth.ts**")).toBe("**__tests__/auth.ts**");
  });
});

describe("the rest of the syntax is untouched", () => {
  test("code spans keep their underscores and stay code", () => {
    expect(inlineTypes("`__init__` in code")).toContain("codespan");
    expect(inlineText("`__init__` in code")).toBe("`__init__` in code");
  });

  test("block structures still lex", () => {
    const tokens = lexMarkdown(
      "# Heading\n\n- item one\n- item two\n\n```ts\nconst __x = 1;\n```\n",
    );

    // marked emits a "space" token between blocks; the blocks are what matter.
    expect(tokens.map((token) => token.type).filter((type) => type !== "space")).toEqual([
      "heading",
      "list",
      "code",
    ]);
  });

  test("a fenced block keeps its underscores verbatim", () => {
    const tokens = lexMarkdown("t\n\n- a\n\n```py\ndef __init__(self):\n    pass\n```\n") as Array<{
      type: string;
      text?: string;
    }>;
    const code = tokens.find((token) => token.type === "code");

    expect(code).toBeDefined();
    expect(code?.text).toContain("__init__");
  });
});
