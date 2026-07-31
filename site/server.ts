import index from "./index.html";

const PUBLIC = new URL("./public/", import.meta.url).pathname;

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

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/": index,
    "/favicon.svg": () => asset("favicon.svg"),
    "/terminal.png": () => asset("terminal.png"),
    "/demo.mp4": () => asset("demo.mp4"),
    "/demo-poster.jpg": () => asset("demo-poster.jpg"),
    // Unused by the page; kept so the scene can swap to a still or a webm.
    "/hero.jpg": () => asset("hero.jpg"),
    "/demo.webm": () => asset("demo.webm"),
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Woopcode site → ${server.url}`);
