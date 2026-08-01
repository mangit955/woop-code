/**
 * Static build for Vercel deployment.
 *
 * Produces a fully self-contained `site/dist/` directory:
 *
 *   1. Bundles the React landing page (index.html + JS + CSS)
 *   2. Copies static assets from site/public/ (images, video, fonts, favicon)
 *   3. Pre-renders every docs page from docs/*.md into static HTML
 *   4. Pre-generates the search index (search.json)
 *   5. Copies docs CSS and client JS
 *
 * Run with: bun ./site/scripts/build-static.ts
 */

import { rmSync, mkdirSync, cpSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { renderIndex, renderPage, renderNotFound } from "../src/docs/render";
import { allSlugs } from "../src/docs/pages";
import { buildIndex } from "../src/docs/search";

const ROOT = resolve(import.meta.dir, "../..");
const SITE = resolve(ROOT, "site");
const DIST = resolve(SITE, "dist");
const PUBLIC = resolve(SITE, "public");
const DOCS_SRC = resolve(SITE, "src/docs");

// ─── 0. Clean ───────────────────────────────────────────────────────────────

console.log("🗑  Cleaning dist/");
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// ─── 1. Bundle the landing page ─────────────────────────────────────────────

console.log("📦  Bundling landing page…");

const buildResult = await Bun.build({
  entrypoints: [resolve(SITE, "index.html")],
  outdir: DIST,
  minify: true,
});

if (!buildResult.success) {
  console.error("❌  Landing page build failed:");
  for (const log of buildResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`   → ${buildResult.outputs.length} files`);

// ─── 2. Copy static assets ─────────────────────────────────────────────────

console.log("📂  Copying static assets…");
cpSync(PUBLIC, DIST, { recursive: true });

// ─── 3. Pre-render docs ────────────────────────────────────────────────────

console.log("📝  Pre-rendering docs…");

const docsDir = resolve(DIST, "docs");
mkdirSync(docsDir, { recursive: true });

// Docs index page (/docs)
const indexHtml = await renderIndex();
writeFileSync(resolve(docsDir, "index.html"), indexHtml);
console.log("   → /docs/index.html");

// Every individual docs page
const slugs = await allSlugs();
let pageCount = 0;

for (const slug of slugs) {
  const html = await renderPage(slug);
  if (html === null) continue;

  const outPath = resolve(docsDir, slug, "index.html");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  pageCount++;
}

console.log(`   → ${pageCount} docs pages`);

// 404 page for Vercel's cleanUrls
const notFoundHtml = await renderNotFound("");
writeFileSync(resolve(docsDir, "404.html"), notFoundHtml);
console.log("   → /docs/404.html");

// ─── 4. Search index ───────────────────────────────────────────────────────

console.log("🔍  Generating search index…");
const searchIndex = await buildIndex();
writeFileSync(
  resolve(docsDir, "search.json"),
  JSON.stringify(searchIndex),
);
console.log(`   → ${searchIndex.length} entries`);

// ─── 5. Docs CSS and client JS ─────────────────────────────────────────────

console.log("🎨  Copying docs assets…");

const docsAssets = [
  "tokens.css",
  "tokens.generated.css",
  "layout.css",
  "components.css",
  "client.js",
];

for (const file of docsAssets) {
  cpSync(resolve(DOCS_SRC, file), resolve(docsDir, file));
}

console.log(`   → ${docsAssets.length} files`);

// ─── Done ───────────────────────────────────────────────────────────────────

console.log("\n✅  Static build complete → site/dist/");
