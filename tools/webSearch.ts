import type { Tool } from "../config/types";

/**
 * Consecutive fruitless searches before the tool reports itself unavailable.
 *
 * A benchmark trial spent 37 of its 78 tool calls on web_search, and every one
 * returned "No search results found"; the rerun did it again 27 times. The
 * search is an HTML scrape of DuckDuckGo, which a sandboxed container either
 * blocks or serves a bot page — so the tool cannot work there at all, and the
 * agent has no way to learn that from one empty result.
 *
 * The loop's duplicate guard cannot catch this: it keys on exact arguments, and
 * all 37 queries differed. Only the tool knows that the last several attempts
 * were barren regardless of what was asked.
 *
 * Three rather than one, because an empty result for a genuinely obscure query
 * is ordinary and should not disable a working search.
 */
const BARREN_SEARCHES_BEFORE_UNAVAILABLE = 3;

const UNAVAILABLE =
  "Web search is unavailable in this environment: the last " +
  `${BARREN_SEARCHES_BEFORE_UNAVAILABLE} searches all returned nothing. ` +
  "Do not search again. Work from the files and tools available locally.";

let barrenSearches = 0;

/** Clears the barren-search count. For tests; the count is per process. */
export function resetWebSearchAvailability() {
  barrenSearches = 0;
}

export const webSearchTool: Tool = {
  name: "web_search",
  description: `Search the web for current information, documentation, or answers to questions.

Use this when you need:
- Current/up-to-date information (news, prices, versions, etc.)
- Documentation or API references
- Technical solutions or stack overflow answers
- Verify information that may have changed recently

Returns a list of relevant web pages with titles, URLs, and snippets.

Current year: ${new Date().getFullYear()}`,

  parameters: [
    {
      name: "query",
      description: "The search query (e.g., 'latest nodejs version', 'how to use react hooks')",
      required: true,
    },
    {
      name: "numResults",
      description: "Number of search results to return (default: 5, max: 10)",
      required: false,
      type: "number",
    },
  ],

  async execute(args, signal) {
    const query = args.query as string;
    const numResults = Math.min((args.numResults as number) || 5, 10);

    if (!query || query.trim().length === 0) {
      throw new Error("Search query is required");
    }

    // Checked before the request, so a search that cannot work stops costing a
    // round trip as well as an iteration.
    if (barrenSearches >= BARREN_SEARCHES_BEFORE_UNAVAILABLE) {
      return UNAVAILABLE;
    }

    // Use DuckDuckGo Instant Answer API (free, no API key needed)
    try {
      const encodedQuery = encodeURIComponent(query);
      
      // Try DuckDuckGo HTML search (scraping)
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
      
      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; WoopCode/1.0)",
        },
        signal,
      });

      if (!response.ok) {
        throw new Error(`Search failed with status: ${response.status}`);
      }

      const html = await response.text();
      
      // Parse search results from HTML
      const results = parseSearchResults(html, numResults);

      if (results.length === 0) {
        barrenSearches++;
        return `No search results found for: "${query}"\n\nTry:\n- Using different keywords\n- Being more specific\n- Checking spelling`;
      }

      // A search that returned something proves the environment can reach the
      // index, so earlier empties were about the queries rather than the network.
      barrenSearches = 0;

      // Format results
      const output: string[] = [
        `Search results for: "${query}"\n`,
        `Found ${results.length} result${results.length !== 1 ? "s" : ""}:\n`,
      ];

      results.forEach((result, index) => {
        output.push(`${index + 1}. ${result.title}`);
        output.push(`   URL: ${result.url}`);
        if (result.snippet) {
          output.push(`   ${result.snippet}`);
        }
        output.push("");
      });

      output.push(
        `\nNote: Use web_fetch tool to read full content from specific URLs.`
      );

      return output.join("\n");
    } catch (error) {
      // A failed request is as barren as an empty one, and a container with no
      // network out fails here rather than returning zero results. Cancellation
      // is not: the turn was interrupted, which says nothing about the search.
      if (!signal?.aborted) barrenSearches++;

      throw new Error(
        `Web search failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

function parseSearchResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Simple regex-based parsing for DuckDuckGo HTML results
  // This is a basic implementation - in production, use a proper HTML parser
  
  // Match result blocks
  const resultRegex = /<div class="result__body">[\s\S]*?<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  
  let match;
  while ((match = resultRegex.exec(html)) && results.length < limit) {
    const url = decodeURIComponent(match[1] || "");
    const title = stripHtml(match[2] || "").trim();
    const snippet = match[3] ? stripHtml(match[3]).trim() : undefined;

    // Filter out DuckDuckGo internal URLs
    if (url && !url.includes("duckduckgo.com") && title) {
      results.push({
        title: title.slice(0, 200), // Limit title length
        url: url.slice(0, 500), // Limit URL length
        snippet: snippet?.slice(0, 300), // Limit snippet length
      });
    }
  }

  return results;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "") // Remove HTML tags
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
}
