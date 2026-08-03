import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  webSearchTool,
  resetWebSearchAvailability,
} from "../../../tools/webSearch";

/**
 * The tool stops searching once the environment proves it cannot.
 *
 * A benchmark trial spent 37 of 78 tool calls on web_search, every one
 * answered "No search results found" — the search is an HTML scrape, and a
 * sandboxed container serves it a bot page. The loop's duplicate guard keys on
 * exact arguments and all 37 queries differed, so nothing stopped it.
 *
 * `fetch` is stubbed rather than called: the suite makes no network requests,
 * and the behaviour under test is what the tool does with the answer, not how
 * DuckDuckGo replies. `globalThis.fetch` is writable, so this needs no module
 * mock and cannot leak into another file the way `mock.module` would.
 */
describe("web_search availability", () => {
  const realFetch = globalThis.fetch;

  /**
   * Installs a stub, keeping the properties Bun hangs off `fetch`.
   *
   * `typeof fetch` here carries `preconnect`, so a bare function does not
   * satisfy it; borrowing the real one keeps the stub type-correct without
   * casting through `unknown`.
   */
  function stubFetch(handler: () => Promise<Response>) {
    globalThis.fetch = Object.assign(handler, {
      preconnect: realFetch.preconnect,
    });
  }

  /** A page that parses to zero results — what the container actually gets. */
  const respondEmpty = () =>
    stubFetch(
      async () =>
        new Response("<html><body>no results</body></html>", { status: 200 }),
    );

  beforeEach(() => {
    resetWebSearchAvailability();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetWebSearchAvailability();
  });

  test("reports the empty result for the first few searches", async () => {
    respondEmpty();

    for (const query of ["povray 2.2 source", "povray 2.2 tar.Z", "povray22"]) {
      const output = await webSearchTool.execute({ query });
      expect(output).toContain("No search results found");
      expect(output).not.toContain("unavailable in this environment");
    }
  });

  test("reports itself unavailable once searching is proven barren", async () => {
    respondEmpty();

    for (const query of ["one", "two", "three"]) {
      await webSearchTool.execute({ query });
    }

    const output = await webSearchTool.execute({ query: "four" });
    expect(output).toContain("Web search is unavailable in this environment");
    expect(output).toContain("Do not search again");
  });

  test("stops making requests once unavailable", async () => {
    respondEmpty();
    for (const query of ["one", "two", "three"]) {
      await webSearchTool.execute({ query });
    }

    let requests = 0;
    stubFetch(async () => {
      requests++;
      return new Response("<html></html>", { status: 200 });
    });

    await webSearchTool.execute({ query: "four" });
    expect(requests).toBe(0);
  });

  test("counts a failed request as barren too", async () => {
    // A container with no route out throws here rather than returning zero
    // results, and would otherwise never reach the counter.
    stubFetch(async () => {
      throw new Error("getaddrinfo ENOTFOUND html.duckduckgo.com");
    });

    for (const query of ["one", "two", "three"]) {
      await expect(webSearchTool.execute({ query })).rejects.toThrow(
        "Web search failed",
      );
    }

    const output = await webSearchTool.execute({ query: "four" });
    expect(output).toContain("Web search is unavailable in this environment");
  });

  test("does not count a cancelled search against the budget", async () => {
    const controller = new AbortController();
    controller.abort();

    stubFetch(async () => {
      throw new Error("The operation was aborted");
    });

    for (const query of ["one", "two", "three"]) {
      await expect(
        webSearchTool.execute({ query }, controller.signal),
      ).rejects.toThrow();
    }

    // Cancellation says nothing about whether search works, so the next call
    // still tries.
    respondEmpty();
    const output = await webSearchTool.execute({ query: "four" });
    expect(output).toContain("No search results found");
  });

  test("a search that finds something clears the count", async () => {
    respondEmpty();
    await webSearchTool.execute({ query: "one" });
    await webSearchTool.execute({ query: "two" });

    // Shaped to match the parser in tools/webSearch.ts: a result__body wrapper
    // around a result__a anchor, on a host that is not duckduckgo.com.
    stubFetch(
      async () =>
        new Response(
          `<div class="result__body">` +
            `<a rel="nofollow" class="result__a" href="https://example.com/povray">POV-Ray</a>` +
            `</div>`,
          { status: 200 },
        ),
    );
    const found = await webSearchTool.execute({ query: "three" });
    expect(found).toContain("Search results for");

    // Two barren searches before a successful one must not add up to a
    // disabled tool.
    respondEmpty();
    for (const query of ["four", "five"]) {
      const output = await webSearchTool.execute({ query });
      expect(output).toContain("No search results found");
    }
  });
});
