import index from "./index.html";
import { renderIndex, renderNotFound, renderPage } from "./src/docs/render";
import { buildIndex } from "./src/docs/search";

const PUBLIC = new URL("./public/", import.meta.url).pathname;
const DOCS_CSS = new URL("./src/docs/", import.meta.url).pathname;

/**
 * Static assets (demo video, poster, favicon) live in site/public.
 * The font is not here — it is referenced from styles.css, so the bundler
 * fingerprints and serves it.
 */
async function asset(name: string) {
  const file = Bun.file(PUBLIC + name);
  return (await file.exists())
    ? new Response(file, {
        headers: { "cache-control": "public, max-age=3600" },
      })
    : new Response("Not found", { status: 404 });
}

/**
 * The docs preview.
 *
 * Deliberately outside the React app and outside the bundler: the docs are
 * markdown rendered on request, so a prose edit is visible on reload with no
 * build step, and the docs' tokens cannot leak into the landing page. Neither
 * stylesheet is imported by `index.html`.
 */
const DOCS_ASSET_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
};

async function docsAsset(name: string) {
  const file = Bun.file(DOCS_CSS + name);
  const extension = name.split(".").pop() ?? "";

  return (await file.exists())
    ? new Response(file, {
        headers: {
          "content-type": DOCS_ASSET_TYPES[extension] ?? "text/plain",
          // No caching: a docs edit should be one reload away.
          "cache-control": "no-store",
        },
      })
    : new Response("Not found", { status: 404 });
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/": index,
    "/favicon.svg": () => asset("favicon.svg"),

    // Docs — see site/src/docs/render.ts.
    "/docs": async () => html(await renderIndex()),
    "/docs/tokens.css": () => docsAsset("tokens.css"),
    "/docs/tokens.generated.css": () => docsAsset("tokens.generated.css"),
    "/docs/layout.css": () => docsAsset("layout.css"),
    "/docs/components.css": () => docsAsset("components.css"),
    "/docs/client.js": () => docsAsset("client.js"),

    // The search index, built from the same markdown the pages render from.
    // Fetched once, lazily, the first time the palette is opened.
    "/docs/search.json": async () =>
      new Response(JSON.stringify(await buildIndex()), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      }),
    "/docs/*": async (request) => {
      const slug = new URL(request.url).pathname.replace(/^\/docs\//, "");
      const page = await renderPage(slug);

      // A miss still gets the full shell — sidebar, search, somewhere to go —
      // and a real 404 status so crawlers do not index it.
      return page ? html(page) : html(await renderNotFound(slug), 404);
    },

    // The docs shell loads the font directly rather than through the bundler,
    // which is what fingerprints it for the landing page.
    "/fonts/inter-latin.woff2": async () => {
      const file = Bun.file(PUBLIC + "fonts/inter-latin.woff2");
      return new Response(file, {
        headers: {
          "content-type": "font/woff2",
          "cache-control": "public, max-age=3600",
        },
      });
    },

    "/terminal.png": () => asset("terminal.png"),
    "/terminal1.mp4": () => asset("terminal1.mp4"),
    "/demo-poster.jpg": () => asset("demo-poster.jpg"),
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Woopcode site → ${server.url}`);
