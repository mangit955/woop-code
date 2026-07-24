import { bench, describe } from "bun:test";
import { createTwoFilesPatch, applyPatch } from "diff";
import { marked } from "marked";

/**
 * BENCHMARKS FOR CORE OPERATIONS
 * 
 * Tracks performance of critical paths to catch regressions.
 */

describe("Diff Operations", () => {
  const smallText = "Hello, world!";
  const mediumText = "x".repeat(1000);
  const largeText = "x".repeat(10000);

  bench("diff generation - small text (13 chars)", () => {
    createTwoFilesPatch(
      "file.txt",
      "file.txt",
      smallText,
      smallText + " modified",
      "",
      ""
    );
  });

  bench("diff generation - medium text (1KB)", () => {
    createTwoFilesPatch(
      "file.txt",
      "file.txt",
      mediumText,
      mediumText + " modified",
      "",
      ""
    );
  });

  bench("diff generation - large text (10KB)", () => {
    createTwoFilesPatch(
      "file.txt",
      "file.txt",
      largeText,
      largeText + " modified",
      "",
      ""
    );
  });

  bench("patch application - small text", () => {
    const patch = createTwoFilesPatch(
      "file.txt",
      "file.txt",
      smallText,
      smallText + " modified",
      "",
      ""
    );
    applyPatch(smallText, patch);
  });

  bench("patch application - medium text", () => {
    const patch = createTwoFilesPatch(
      "file.txt",
      "file.txt",
      mediumText,
      mediumText + " modified",
      "",
      ""
    );
    applyPatch(mediumText, patch);
  });

  bench("patch application - large text", () => {
    const patch = createTwoFilesPatch(
      "file.txt",
      "file.txt",
      largeText,
      largeText + " modified",
      "",
      ""
    );
    applyPatch(largeText, patch);
  });
});

describe("Markdown Rendering", () => {
  const simpleMarkdown = "# Header\n\nParagraph with **bold** and *italic*.";
  const complexMarkdown = `
# Main Header

## Section 1

This is a paragraph with **bold**, *italic*, and \`code\`.

### Subsection

- List item 1
- List item 2
  - Nested item
  - Another nested

\`\`\`javascript
function test() {
  return 42;
}
\`\`\`

[Link](https://example.com)

> Blockquote

| Col 1 | Col 2 |
|-------|-------|
| A     | B     |
`;

  const largeMarkdown = "# Header\n\n" + "Paragraph text. ".repeat(1000);

  bench("markdown render - simple (50 chars)", () => {
    marked.parse(simpleMarkdown);
  });

  bench("markdown render - complex (300 chars)", () => {
    marked.parse(complexMarkdown);
  });

  bench("markdown render - large (16KB)", () => {
    marked.parse(largeMarkdown);
  });
});

describe("JSON Parsing", () => {
  const smallJson = JSON.stringify({ key: "value" });
  const mediumJson = JSON.stringify({
    users: Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `User ${i}`,
      email: `user${i}@example.com`,
    })),
  });
  const largeJson = JSON.stringify({
    data: Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      nested: {
        value1: Math.random(),
        value2: Math.random(),
        array: [1, 2, 3, 4, 5],
      },
    })),
  });

  bench("JSON.parse - small (16 bytes)", () => {
    JSON.parse(smallJson);
  });

  bench("JSON.parse - medium (5KB)", () => {
    JSON.parse(mediumJson);
  });

  bench("JSON.parse - large (88KB)", () => {
    JSON.parse(largeJson);
  });

  bench("JSON.stringify - small object", () => {
    JSON.stringify({ key: "value" });
  });

  bench("JSON.stringify - medium object", () => {
    JSON.stringify({
      users: Array.from({ length: 100 }, (_, i) => ({
        id: i,
        name: `User ${i}`,
      })),
    });
  });

  bench("JSON.stringify - large object", () => {
    JSON.stringify({
      data: Array.from({ length: 1000 }, (_, i) => ({ id: i, value: i * 2 })),
    });
  });
});

describe("String Operations", () => {
  const smallString = "Hello, world!";
  const mediumString = "x".repeat(1000);
  const largeString = "x".repeat(10000);

  bench("string concatenation - small (13 chars)", () => {
    smallString + " modified";
  });

  bench("string concatenation - medium (1KB)", () => {
    mediumString + " modified";
  });

  bench("string concatenation - large (10KB)", () => {
    largeString + " modified";
  });

  bench("string replace - small", () => {
    smallString.replace("world", "universe");
  });

  bench("string replace - medium", () => {
    mediumString.replace(/x{10}/g, "y".repeat(10));
  });

  bench("string split - lines (small)", () => {
    "line1\nline2\nline3\nline4\nline5".split("\n");
  });

  bench("string split - lines (medium)", () => {
    mediumString.split("\n");
  });

  bench("string includes - small", () => {
    smallString.includes("world");
  });

  bench("string includes - large", () => {
    largeString.includes("y");
  });
});

describe("Array Operations", () => {
  const smallArray = Array.from({ length: 10 }, (_, i) => i);
  const mediumArray = Array.from({ length: 1000 }, (_, i) => i);
  const largeArray = Array.from({ length: 10000 }, (_, i) => i);

  bench("array map - small (10 items)", () => {
    smallArray.map((x) => x * 2);
  });

  bench("array map - medium (1K items)", () => {
    mediumArray.map((x) => x * 2);
  });

  bench("array map - large (10K items)", () => {
    largeArray.map((x) => x * 2);
  });

  bench("array filter - small", () => {
    smallArray.filter((x) => x % 2 === 0);
  });

  bench("array filter - medium", () => {
    mediumArray.filter((x) => x % 2 === 0);
  });

  bench("array reduce - small", () => {
    smallArray.reduce((acc, x) => acc + x, 0);
  });

  bench("array reduce - medium", () => {
    mediumArray.reduce((acc, x) => acc + x, 0);
  });

  bench("array push - single item", () => {
    const arr: number[] = [];
    for (let i = 0; i < 100; i++) {
      arr.push(i);
    }
  });

  bench("array push - batch items", () => {
    const arr: number[] = [];
    arr.push(...Array.from({ length: 100 }, (_, i) => i));
  });
});

describe("Object Operations", () => {
  const smallObj = { a: 1, b: 2, c: 3 };
  const mediumObj = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`key${i}`, i])
  );
  const largeObj = Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [`key${i}`, i])
  );

  bench("Object.keys - small (3 keys)", () => {
    Object.keys(smallObj);
  });

  bench("Object.keys - medium (100 keys)", () => {
    Object.keys(mediumObj);
  });

  bench("Object.keys - large (1K keys)", () => {
    Object.keys(largeObj);
  });

  bench("Object.entries - small", () => {
    Object.entries(smallObj);
  });

  bench("Object.entries - medium", () => {
    Object.entries(mediumObj);
  });

  bench("Object spread - small", () => {
    ({ ...smallObj, d: 4 });
  });

  bench("Object spread - medium", () => {
    ({ ...mediumObj, newKey: 999 });
  });

  bench("Object.assign - small", () => {
    Object.assign({}, smallObj, { d: 4 });
  });

  bench("Object.assign - medium", () => {
    Object.assign({}, mediumObj, { newKey: 999 });
  });
});
