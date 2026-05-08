/**
 * Web tools — search and fetch.
 *
 * web_search: backed by DuckDuckGo's HTML endpoint by default (no API key).
 *             Set BRAVE_SEARCH_API_KEY in env to use Brave instead.
 * web_fetch:  fetches a URL and returns text (best-effort markdown extraction).
 */

import { defineTool } from "@cadmus/kernel";

export const webSearch = defineTool({
  name: "web_search",
  description:
    "Search the web. Returns a list of { title, url, snippet }. Uses DuckDuckGo by default; set BRAVE_SEARCH_API_KEY for Brave.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number", default: 5 },
    },
    required: ["query"],
  },
  handler: async (args) => {
    const { query, limit = 5 } = args as { query: string; limit?: number };
    const braveKey = process.env.BRAVE_SEARCH_API_KEY;
    if (braveKey) return braveSearch(query, limit, braveKey);
    return ddgSearch(query, limit);
  },
});

async function braveSearch(query: string, limit: number, key: string) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));
  const res = await fetch(url, {
    headers: { "X-Subscription-Token": key, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`brave: ${res.status}`);
  const data = (await res.json()) as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
  return (data.web?.results ?? []).slice(0, limit).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));
}

async function ddgSearch(query: string, limit: number) {
  // DuckDuckGo's HTML SERP. Lightweight scrape, no key required.
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 cadmus-tools",
    },
  });
  if (!res.ok) throw new Error(`ddg: ${res.status}`);
  const html = await res.text();
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  // crude extraction — DDG's HTML SERP has a simple shape.
  const re =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < limit) {
    results.push({
      url: decodeURIComponent(m[1].replace(/^\/l\/\?uddg=/, "").replace(/&rut=.*$/, "")),
      title: stripTags(m[2]).trim(),
      snippet: stripTags(m[3]).trim(),
    });
  }
  return results;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
}

export const webFetch = defineTool({
  name: "web_fetch",
  description:
    "Fetch a URL and return its text content. Strips most HTML tags; capped at 30k chars.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string" },
      max_chars: { type: "number", default: 30000 },
    },
    required: ["url"],
  },
  handler: async (args) => {
    const { url, max_chars = 30000 } = args as { url: string; max_chars?: number };
    const res = await fetch(url, {
      headers: { "User-Agent": "cadmus-tools/0.1" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`fetch: ${res.status} ${res.statusText}`);
    const ct = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const text = ct.includes("text/html") ? extractTextFromHtml(raw) : raw;
    return {
      url,
      content_type: ct,
      content: text.slice(0, max_chars),
      truncated: text.length > max_chars,
    };
  },
});

function extractTextFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
