import type { Tool } from "../config/types";

export const webFetchTool: Tool = {
  name: "web_fetch",
  description: `Fetch and extract content from a specific URL.

Use this to:
- Read documentation pages
- Fetch article content
- Get data from specific web pages
- Read content found via web_search

Supports:
- HTML pages (converts to readable text)
- Plain text
- JSON data
- Markdown

Max response size: 5MB
Default timeout: 30 seconds`,

  parameters: [
    {
      name: "url",
      description: "The URL to fetch content from (must start with http:// or https://)",
      required: true,
    },
    {
      name: "format",
      description: "Output format: 'text', 'markdown', or 'html' (default: 'markdown')",
      required: false,
    },
    {
      name: "timeout",
      description: "Timeout in seconds (default: 30, max: 120)",
      required: false,
      type: "number",
    },
  ],

  async execute(args) {
    const url = args.url as string;
    const format = (args.format as string) || "markdown";
    const timeoutSeconds = Math.min((args.timeout as number) || 30, 120);

    // Validation
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      throw new Error("URL must start with http:// or https://");
    }

    if (!["text", "markdown", "html"].includes(format)) {
      throw new Error("Format must be 'text', 'markdown', or 'html'");
    }

    const MAX_SIZE = 5 * 1024 * 1024; // 5MB
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; WoopCode/1.0; +https://github.com/mangit955/woop-code)",
          Accept:
            format === "html"
              ? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
              : format === "text"
              ? "text/plain;q=1.0,text/html;q=0.8,*/*;q=0.1"
              : "text/markdown;q=1.0,text/plain;q=0.9,text/html;q=0.7,*/*;q=0.1",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Check content length
      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength) > MAX_SIZE) {
        throw new Error("Response too large (exceeds 5MB limit)");
      }

      const contentType = response.headers.get("content-type") || "";
      
      // Handle images
      if (contentType.includes("image/")) {
        return `Image fetched from ${url}\nContent-Type: ${contentType}\n\nNote: Image content cannot be displayed in text format.`;
      }

      // Get content
      const text = await response.text();

      if (text.length > MAX_SIZE) {
        throw new Error("Response too large (exceeds 5MB limit)");
      }

      // Process based on format
      let output = text;

      if (format === "text" && contentType.includes("text/html")) {
        output = extractTextFromHTML(text);
      } else if (format === "markdown" && contentType.includes("text/html")) {
        output = convertHTMLToMarkdown(text);
      }

      // Truncate if still too long for context
      const MAX_OUTPUT = 50 * 1024; // 50KB for LLM context
      if (output.length > MAX_OUTPUT) {
        output =
          output.slice(0, MAX_OUTPUT) +
          `\n\n[Content truncated - showing first ${MAX_OUTPUT} characters of ${output.length}]`;
      }

      return `Content from: ${url}\nContent-Type: ${contentType}\n\n${output}`;
    } catch (error: any) {
      if (error.name === "AbortError") {
        throw new Error(`Request timed out after ${timeoutSeconds} seconds`);
      }
      throw new Error(
        `Failed to fetch URL: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timeoutId);
    }
  },
};

function extractTextFromHTML(html: string): string {
  // Remove script, style, and other non-content tags
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, "")
    .replace(/<embed\b[^<]*>/gi, "");

  // Replace common block elements with newlines
  text = text
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/tr>/gi, "\n");

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = decodeHTMLEntities(text);

  // Clean up whitespace
  text = text
    .replace(/\n\s*\n\s*\n/g, "\n\n") // Remove excessive newlines
    .replace(/[ \t]+/g, " ") // Normalize spaces
    .trim();

  return text;
}

function convertHTMLToMarkdown(html: string): string {
  // Basic HTML to Markdown conversion
  // For production, consider using a library like 'turndown'
  
  let md = html;

  // Remove script, style tags
  md = md
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");

  // Headers
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "\n# $1\n");
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "\n## $1\n");
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "\n### $1\n");
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "\n#### $1\n");
  md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, "\n##### $1\n");
  md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, "\n###### $1\n");

  // Strong/Bold
  md = md.replace(/<(strong|b)[^>]*>(.*?)<\/\1>/gi, "**$2**");

  // Emphasis/Italic
  md = md.replace(/<(em|i)[^>]*>(.*?)<\/\1>/gi, "*$2*");

  // Code
  md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`");
  md = md.replace(/<pre[^>]*>(.*?)<\/pre>/gis, "\n```\n$1\n```\n");

  // Links
  md = md.replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)");

  // Images
  md = md.replace(/<img[^>]+src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, "![$2]($1)");
  md = md.replace(/<img[^>]+src="([^"]*)"[^>]*>/gi, "![]($1)");

  // Lists
  md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");
  md = md.replace(/<\/?[uo]l[^>]*>/gi, "\n");

  // Paragraphs and breaks
  md = md.replace(/<\/p>/gi, "\n\n");
  md = md.replace(/<br\s*\/?>/gi, "\n");

  // Remove remaining HTML tags
  md = md.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  md = decodeHTMLEntities(md);

  // Clean up whitespace
  md = md
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  return md;
}

function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&copy;/g, "©")
    .replace(/&reg;/g, "®")
    .replace(/&trade;/g, "™");
}
