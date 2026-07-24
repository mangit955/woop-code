#!/usr/bin/env bun

/**
 * Performance Testing Script
 * 
 * This script measures performance of core operations to detect regressions.
 */

import { createTwoFilesPatch, applyPatch } from "diff";
import { marked } from "marked";

console.log("🚀 Running Performance Tests...\n");

// ============================================================================
// 1. DIFF OPERATIONS
// ============================================================================
console.log("📊 Testing Diff Operations");
console.log("─".repeat(50));

const runDiffTests = () => {
  const smallText = "Hello, world!";
  const mediumText = "x".repeat(1000);
  const largeText = "x".repeat(10000);

  // Test 1: Small diff generation
  const start1 = performance.now();
  for (let i = 0; i < 1000; i++) {
    createTwoFilesPatch("file.txt", "file.txt", smallText, smallText + " modified", "", "");
  }
  const time1 = performance.now() - start1;
  console.log(`✓ Small diff (13 chars) x 1000: ${time1.toFixed(2)}ms (${(time1/1000).toFixed(3)}ms each)`);

  // Test 2: Medium diff generation
  const start2 = performance.now();
  for (let i = 0; i < 100; i++) {
    createTwoFilesPatch("file.txt", "file.txt", mediumText, mediumText + " modified", "", "");
  }
  const time2 = performance.now() - start2;
  console.log(`✓ Medium diff (1KB) x 100: ${time2.toFixed(2)}ms (${(time2/100).toFixed(3)}ms each)`);

  // Test 3: Large diff generation
  const start3 = performance.now();
  for (let i = 0; i < 10; i++) {
    createTwoFilesPatch("file.txt", "file.txt", largeText, largeText + " modified", "", "");
  }
  const time3 = performance.now() - start3;
  console.log(`✓ Large diff (10KB) x 10: ${time3.toFixed(2)}ms (${(time3/10).toFixed(3)}ms each)`);

  // Test 4: Patch application
  const patch = createTwoFilesPatch("file.txt", "file.txt", mediumText, mediumText + " modified", "", "");
  const start4 = performance.now();
  for (let i = 0; i < 100; i++) {
    applyPatch(mediumText, patch);
  }
  const time4 = performance.now() - start4;
  console.log(`✓ Patch apply (1KB) x 100: ${time4.toFixed(2)}ms (${(time4/100).toFixed(3)}ms each)`);
};

runDiffTests();

// ============================================================================
// 2. MARKDOWN RENDERING
// ============================================================================
console.log("\n📊 Testing Markdown Rendering");
console.log("─".repeat(50));

const runMarkdownTests = () => {
  const simpleMarkdown = "# Header\n\nParagraph with **bold** and *italic*.";
  const complexMarkdown = `
# Main Header

## Section 1

This is a paragraph with **bold**, *italic*, and \`code\`.

### Subsection

- List item 1
- List item 2
  - Nested item

\`\`\`javascript
function test() {
  return 42;
}
\`\`\`

[Link](https://example.com)
`;
  const largeMarkdown = "# Header\n\n" + "Paragraph text. ".repeat(1000);

  // Test 1: Simple markdown
  const start1 = performance.now();
  for (let i = 0; i < 1000; i++) {
    marked.parse(simpleMarkdown);
  }
  const time1 = performance.now() - start1;
  console.log(`✓ Simple markdown x 1000: ${time1.toFixed(2)}ms (${(time1/1000).toFixed(3)}ms each)`);

  // Test 2: Complex markdown
  const start2 = performance.now();
  for (let i = 0; i < 100; i++) {
    marked.parse(complexMarkdown);
  }
  const time2 = performance.now() - start2;
  console.log(`✓ Complex markdown x 100: ${time2.toFixed(2)}ms (${(time2/100).toFixed(3)}ms each)`);

  // Test 3: Large markdown
  const start3 = performance.now();
  for (let i = 0; i < 10; i++) {
    marked.parse(largeMarkdown);
  }
  const time3 = performance.now() - start3;
  console.log(`✓ Large markdown (16KB) x 10: ${time3.toFixed(2)}ms (${(time3/10).toFixed(3)}ms each)`);
};

runMarkdownTests();

// ============================================================================
// 3. JSON OPERATIONS
// ============================================================================
console.log("\n📊 Testing JSON Operations");
console.log("─".repeat(50));

const runJsonTests = () => {
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
      },
    })),
  });

  // Test 1: Small JSON parse
  const start1 = performance.now();
  for (let i = 0; i < 10000; i++) {
    JSON.parse(smallJson);
  }
  const time1 = performance.now() - start1;
  console.log(`✓ Parse small JSON x 10000: ${time1.toFixed(2)}ms (${(time1/10000).toFixed(4)}ms each)`);

  // Test 2: Medium JSON parse
  const start2 = performance.now();
  for (let i = 0; i < 1000; i++) {
    JSON.parse(mediumJson);
  }
  const time2 = performance.now() - start2;
  console.log(`✓ Parse medium JSON (5KB) x 1000: ${time2.toFixed(2)}ms (${(time2/1000).toFixed(3)}ms each)`);

  // Test 3: Large JSON parse
  const start3 = performance.now();
  for (let i = 0; i < 100; i++) {
    JSON.parse(largeJson);
  }
  const time3 = performance.now() - start3;
  console.log(`✓ Parse large JSON (88KB) x 100: ${time3.toFixed(2)}ms (${(time3/100).toFixed(3)}ms each)`);
};

runJsonTests();

// ============================================================================
// 4. STRING OPERATIONS
// ============================================================================
console.log("\n📊 Testing String Operations");
console.log("─".repeat(50));

const runStringTests = () => {
  const smallString = "Hello, world!";
  const mediumString = "x".repeat(1000);
  const largeString = "x".repeat(10000);

  // Test 1: String concatenation
  const start1 = performance.now();
  for (let i = 0; i < 100000; i++) {
    const result = smallString + " modified";
  }
  const time1 = performance.now() - start1;
  console.log(`✓ String concat (small) x 100000: ${time1.toFixed(2)}ms (${(time1/100000).toFixed(4)}ms each)`);

  // Test 2: String replace
  const start2 = performance.now();
  for (let i = 0; i < 10000; i++) {
    mediumString.replace(/x{10}/g, "y".repeat(10));
  }
  const time2 = performance.now() - start2;
  console.log(`✓ String replace (1KB) x 10000: ${time2.toFixed(2)}ms (${(time2/10000).toFixed(4)}ms each)`);

  // Test 3: String split
  const multiline = "line1\nline2\nline3\nline4\nline5";
  const start3 = performance.now();
  for (let i = 0; i < 100000; i++) {
    multiline.split("\n");
  }
  const time3 = performance.now() - start3;
  console.log(`✓ String split x 100000: ${time3.toFixed(2)}ms (${(time3/100000).toFixed(4)}ms each)`);
};

runStringTests();

// ============================================================================
// 5. ARRAY OPERATIONS
// ============================================================================
console.log("\n📊 Testing Array Operations");
console.log("─".repeat(50));

const runArrayTests = () => {
  const smallArray = Array.from({ length: 10 }, (_, i) => i);
  const mediumArray = Array.from({ length: 1000 }, (_, i) => i);
  const largeArray = Array.from({ length: 10000 }, (_, i) => i);

  // Test 1: Array map (small)
  const start1 = performance.now();
  for (let i = 0; i < 10000; i++) {
    smallArray.map((x) => x * 2);
  }
  const time1 = performance.now() - start1;
  console.log(`✓ Array.map (10 items) x 10000: ${time1.toFixed(2)}ms (${(time1/10000).toFixed(4)}ms each)`);

  // Test 2: Array map (medium)
  const start2 = performance.now();
  for (let i = 0; i < 100; i++) {
    mediumArray.map((x) => x * 2);
  }
  const time2 = performance.now() - start2;
  console.log(`✓ Array.map (1K items) x 100: ${time2.toFixed(2)}ms (${(time2/100).toFixed(3)}ms each)`);

  // Test 3: Array filter
  const start3 = performance.now();
  for (let i = 0; i < 1000; i++) {
    mediumArray.filter((x) => x % 2 === 0);
  }
  const time3 = performance.now() - start3;
  console.log(`✓ Array.filter (1K items) x 1000: ${time3.toFixed(2)}ms (${(time3/1000).toFixed(3)}ms each)`);

  // Test 4: Array reduce
  const start4 = performance.now();
  for (let i = 0; i < 1000; i++) {
    mediumArray.reduce((acc, x) => acc + x, 0);
  }
  const time4 = performance.now() - start4;
  console.log(`✓ Array.reduce (1K items) x 1000: ${time4.toFixed(2)}ms (${(time4/1000).toFixed(3)}ms each)`);
};

runArrayTests();

// ============================================================================
// SUMMARY
// ============================================================================
console.log("\n✅ Performance Testing Complete!");
console.log("─".repeat(50));
console.log("\n💡 To track regressions:");
console.log("   1. Run this script before changes: bun run-benchmarks.ts > before.txt");
console.log("   2. Make your changes");
console.log("   3. Run again: bun run-benchmarks.ts > after.txt");
console.log("   4. Compare: diff before.txt after.txt");
console.log("\n📈 Performance budgets (targets):");
console.log("   - Diff generation (1KB): < 500µs");
console.log("   - Markdown render (simple): < 100µs");
console.log("   - JSON parse (5KB): < 100µs");
console.log("   - String operations: < 10µs");
console.log("   - Array operations: < 100µs");
