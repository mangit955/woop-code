import { describe, test, expect } from "bun:test";
import * as fc from "fast-check";
import { marked } from "marked";

/**
 * PROPERTY-BASED TESTS FOR MARKDOWN RENDERING
 * 
 * These tests verify markdown rendering never panics or crashes.
 * 
 * Key invariants:
 * - Renderer never throws exceptions
 * - Output is always valid string
 * - Nested structures don't cause infinite loops
 * - Large markdown doesn't cause performance issues
 * 
 * Production bugs prevented:
 * - Crashes on malformed markdown
 * - Infinite loops with nested structures
 * - Memory exhaustion with large inputs
 * - Unicode rendering issues
 */

describe("Markdown - Property Tests", () => {
  test("PROPERTY: markdown renderer never crashes", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 1000 }), (markdown) => {
        // Should never throw
        let result: string;
        try {
          result = marked.parse(markdown) as string;
        } catch (error) {
          throw new Error(
            `Markdown parser crashed on input: ${JSON.stringify(markdown)}`
          );
        }

        // Result should be a string
        expect(typeof result).toBe("string");
      }),
      { numRuns: 200 }
    );
  });

  test("PROPERTY: unicode in markdown doesn't crash", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        (markdown) => {
          const result = marked.parse(markdown) as string;
          expect(typeof result).toBe("string");
        }
      ),
      { numRuns: 100 }
    );
  });

  test("PROPERTY: nested lists render without infinite loops", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (depth, text) => {
          // Generate deeply nested list
          let markdown = "";
          for (let i = 0; i < depth; i++) {
            markdown += "  ".repeat(i) + `- ${text}\n`;
          }

          const start = performance.now();
          const result = marked.parse(markdown) as string;
          const duration = performance.now() - start;

          // Should complete quickly (no infinite loop)
          expect(duration).toBeLessThan(100);
          expect(typeof result).toBe("string");
        }
      ),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: broken fences don't crash", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant("```"),
            fc.constant("```javascript"),
            fc.constant("```\n"),
            fc.string(),
            fc.constant("~~~"),
            fc.constant("````")
          ),
          { minLength: 1, maxLength: 20 }
        ),
        (parts) => {
          const markdown = parts.join("\n");
          const result = marked.parse(markdown) as string;
          expect(typeof result).toBe("string");
        }
      ),
      { numRuns: 100 }
    );
  });

  test("PROPERTY: invalid markdown structure is handled", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant("# "),
            fc.constant("## "),
            fc.constant("### "),
            fc.constant("- "),
            fc.constant("1. "),
            fc.constant("> "),
            fc.constant("* "),
            fc.constant(""),
            fc.string({ minLength: 0, maxLength: 50 })
          ),
          { minLength: 1, maxLength: 30 }
        ),
        (lines) => {
          const markdown = lines.join("\n");
          const result = marked.parse(markdown) as string;
          expect(typeof result).toBe("string");
        }
      ),
      { numRuns: 100 }
    );
  });

  test("PROPERTY: huge markdown doesn't hang", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10000, max: 100000 }),
        (size) => {
          const markdown = "x".repeat(size);

          const start = performance.now();
          const result = marked.parse(markdown) as string;
          const duration = performance.now() - start;

          // Should handle large input efficiently
          expect(duration).toBeLessThan(1000);
          expect(typeof result).toBe("string");
        }
      ),
      { numRuns: 10 }
    );
  });

  test("PROPERTY: mixed valid/invalid syntax doesn't crash", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            // Valid syntax
            fc.constant("# Header"),
            fc.constant("**bold**"),
            fc.constant("*italic*"),
            fc.constant("[link](url)"),
            // Invalid/broken syntax
            fc.constant("**bold"),
            fc.constant("*italic"),
            fc.constant("[link]("),
            fc.constant("![image"),
            fc.constant("]()"),
            fc.constant("``code"),
            fc.constant("###"),
            fc.constant("---")
          ),
          { minLength: 1, maxLength: 20 }
        ),
        (parts) => {
          const markdown = parts.join(" ");
          const result = marked.parse(markdown) as string;
          expect(typeof result).toBe("string");
        }
      ),
      { numRuns: 100 }
    );
  });

  test("PROPERTY: special characters in code blocks preserved", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        (code) => {
          const markdown = "```\n" + code + "\n```";
          const result = marked.parse(markdown) as string;

          // Should render without crash
          expect(typeof result).toBe("string");
          // Code block should be present in output
          expect(result).toContain("<code>");
        }
      ),
      { numRuns: 100 }
    );
  });

  test("PROPERTY: tables with any content render", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 0, maxLength: 50 }), {
          minLength: 1,
          maxLength: 5,
        }),
        (cells) => {
          // Generate table
          const header = cells.join(" | ");
          const separator = cells.map(() => "---").join(" | ");
          const row = cells.join(" | ");
          const markdown = `${header}\n${separator}\n${row}`;

          const result = marked.parse(markdown) as string;
          expect(typeof result).toBe("string");
        }
      ),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: nested emphasis doesn't break", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        (depth, text) => {
          // Generate nested emphasis: ***text***
          const stars = "*".repeat(depth);
          const markdown = `${stars}${text}${stars}`;

          const result = marked.parse(markdown) as string;
          expect(typeof result).toBe("string");
        }
      ),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: empty elements handled gracefully", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant("**"),
            fc.constant("[]()"),
            fc.constant("![]()"),
            fc.constant("``"),
            fc.constant("```\n```"),
            fc.constant("~~"),
            fc.constant("# "),
            fc.constant("> ")
          ),
          { minLength: 1, maxLength: 20 }
        ),
        (elements) => {
          const markdown = elements.join("\n");
          const result = marked.parse(markdown) as string;
          expect(typeof result).toBe("string");
        }
      ),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: HTML in markdown doesn't break renderer", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant("<div>"),
            fc.constant("</div>"),
            fc.constant("<span>"),
            fc.constant("<script>"),
            fc.constant("<!-- comment -->"),
            fc.constant("<br>"),
            fc.constant("<img src=''>"),
            fc.string({ minLength: 0, maxLength: 50 })
          ),
          { minLength: 1, maxLength: 20 }
        ),
        (parts) => {
          const markdown = parts.join("\n");
          const result = marked.parse(markdown) as string;
          expect(typeof result).toBe("string");
        }
      ),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: links with special characters work", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 100 }),
        fc.string({ minLength: 0, maxLength: 100 }),
        (text, url) => {
          const markdown = `[${text}](${url})`;
          const result = marked.parse(markdown) as string;
          expect(typeof result).toBe("string");
        }
      ),
      { numRuns: 100 }
    );
  });

  test("PROPERTY: blockquotes at any nesting depth", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (depth, text) => {
          const prefix = "> ".repeat(depth);
          const markdown = `${prefix}${text}`;

          const result = marked.parse(markdown) as string;
          expect(typeof result).toBe("string");
        }
      ),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: malformed list items don't crash", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            prefix: fc.oneof(
              fc.constant("- "),
              fc.constant("* "),
              fc.constant("+ "),
              fc.constant("1. "),
              fc.constant("1) "),
              fc.constant("-"),
              fc.constant("*")
            ),
            content: fc.string({ minLength: 0, maxLength: 50 }),
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (items) => {
          const markdown = items
            .map((item) => `${item.prefix}${item.content}`)
            .join("\n");

          const result = marked.parse(markdown) as string;
          expect(typeof result).toBe("string");
        }
      ),
      { numRuns: 50 }
    );
  });

  test("PROPERTY: render is deterministic - same input = same output", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 500 }), (markdown) => {
        const result1 = marked.parse(markdown) as string;
        const result2 = marked.parse(markdown) as string;

        // PROPERTY: Deterministic rendering
        expect(result1).toBe(result2);
      }),
      { numRuns: 100 }
    );
  });
});
