/**
 * parallel-fetch.server — autonomous wrapper for Parallel.ai Extract and Search APIs.
 *
 * Resolves two critical collection gaps in OryxScrape:
 *   1. JS-rendered SPA pages (e.g. DRE Portugal OutSystems): plain server-side fetch
 *      returns a 2 KB empty HTML shell; Parallel renders the page fully and returns
 *      clean markdown with the actual regulatory text.
 *   2. Cloudflare-protected pages: Parallel's infrastructure handles bot-detection
 *      without needing a headless browser.
 *
 * Auth strategy (mirrors collect-sources.ts):
 *   - PARALLEL_API_KEY starts with "lovc_" → gateway-backed Lovable connector
 *     (calls connector-gateway.lovable.dev, needs LOVABLE_API_KEY too)
 *   - Any other key → direct call to api.parallel.ai with x-api-key header
 *
 * No Claude in the loop — called directly from cron route handlers.
 */

const PARALLEL_EXTRACT_DIRECT = "https://api.parallel.ai/v1/extract";
const PARALLEL_EXTRACT_GATEWAY = "https://connector-gateway.lovable.dev/parallel/v1/extract";
const PARALLEL_SEARCH_DIRECT = "https://api.parallel.ai/v1/search";
const PARALLEL_SEARCH_GATEWAY = "https://connector-gateway.lovable.dev/parallel/v1/search";

export const PARALLEL_COLLECTOR_VERSION = "parallel-extract@1.0.0";
export const PARALLEL_SEARCH_VERSION = "parallel-search@1.0.0";

/**
 * Minimum character count to treat a fetched HTML page as real content.
 * Below this threshold the page is likely an SPA shell bootstrapped client-side.
 */
export const SPA_SHELL_THRESHOLD = 3000;

function getParallelHeaders(): { endpoint: (path: "extract" | "search") => string; headers: Record<string, string> } {
  const parallelKey = process.env["PARALLEL_API_KEY"];
  if (!parallelKey) throw new Error("PARALLEL_API_KEY is not configured");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const usesGateway = parallelKey.startsWith("lovc_");

  if (usesGateway) {
    const lovableKey = process.env["LOVABLE_API_KEY"];
    if (!lovableKey) throw new Error("LOVABLE_API_KEY is not configured (required for gateway-backed Parallel connection)");
    headers["Authorization"] = `Bearer ${lovableKey}`;
    headers["X-Connection-Api-Key"] = parallelKey;
    return {
      endpoint: (path) => (path === "extract" ? PARALLEL_EXTRACT_GATEWAY : PARALLEL_SEARCH_GATEWAY),
      headers,
    };
  }

  headers["x-api-key"] = parallelKey;
  return {
    endpoint: (path) => (path === "extract" ? PARALLEL_EXTRACT_DIRECT : PARALLEL_SEARCH_DIRECT),
    headers,
  };
}

export type ParallelExtractResult = {
  text: string;
  title: string | null;
  publishedAt: string | null;
  usedParallel: true;
};

type ParallelExtractResponseItem = {
  url?: string;
  title?: string;
  publish_date?: string | null;
  excerpts?: string[] | null;
  full_content?: string | null;
  content?: string | null;
};

type ParallelExtractResponse = {
  results?: ParallelExtractResponseItem[];
};

/**
 * Extract full text from a URL using Parallel.ai.
 *
 * Handles:
 *   - JS-rendered SPA pages (OutSystems, React, Angular SPAs)
 *   - Cloudflare and bot-protected pages
 *   - Regular HTML pages and PDFs
 *
 * Returns clean markdown text. Throws on empty content — never silently
 * returns an empty string.
 *
 * @param url        The URL to extract content from.
 * @param objective  Optional description of what to extract (improves relevance).
 */
export async function extractWithParallel(
  url: string,
  objective?: string,
): Promise<ParallelExtractResult> {
  const { endpoint, headers } = getParallelHeaders();

  const response = await fetch(endpoint("extract"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      urls: [url],
      objective: objective ?? "Extract the full text of this regulatory or legal document.",
      excerpts: false,
      full_content: { max_chars_per_result: 100000 },
      advanced_settings: {
        fetch_policy: { timeout_seconds: 60 },
      },
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Parallel.ai extract failed [${response.status}] for ${url}: ${responseText.slice(0, 400)}`,
    );
  }

  let payload: ParallelExtractResponse;
  try {
    payload = JSON.parse(responseText) as ParallelExtractResponse;
  } catch {
    throw new Error(
      `Parallel.ai extract returned invalid JSON for ${url}: ${responseText.slice(0, 200)}`,
    );
  }

  const result = (payload.results ?? [])[0];
  if (!result) throw new Error(`Parallel.ai extract returned no results for ${url}`);

  const content =
    result.full_content?.trim() ||
    result.content?.trim() ||
    (result.excerpts ?? []).join("\n\n").trim();

  if (!content) throw new Error(`Parallel.ai returned empty content for ${url}`);

  return {
    text: content,
    title: result.title ?? null,
    publishedAt: result.publish_date ?? null,
    usedParallel: true,
  };
}

/**
 * Returns true when an HTTP response body looks like an SPA bootstrap shell
 * rather than rendered document content (less than SPA_SHELL_THRESHOLD chars).
 */
export function looksLikeSpaShell(rawHtml: string): boolean {
  return rawHtml.length < SPA_SHELL_THRESHOLD;
}

export type ParallelSearchHit = {
  url: string;
  title: string;
  snippet: string;
  publishedAt: string | null;
};

export type ParallelSearchResult = {
  hits: ParallelSearchHit[];
};

type ParallelSearchResponseItem = {
  url?: string;
  title?: string;
  snippet?: string;
  content?: string;
  published_at?: string | null;
};

type ParallelSearchResponse = {
  results?: ParallelSearchResponseItem[];
};

/**
 * Web search via Parallel.ai — returns LLM-optimized excerpts.
 * Call directly from cron routes for autonomous document discovery.
 *
 * @param query       Search query.
 * @param maxResults  Max results (default 10).
 */
export async function searchWithParallel(
  query: string,
  maxResults = 10,
): Promise<ParallelSearchResult> {
  const { endpoint, headers } = getParallelHeaders();

  const response = await fetch(endpoint("search"), {
    method: "POST",
    headers,
    body: JSON.stringify({ query, max_results: maxResults }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Parallel.ai search failed [${response.status}] for "${query}": ${responseText.slice(0, 400)}`,
    );
  }

  let payload: ParallelSearchResponse;
  try {
    payload = JSON.parse(responseText) as ParallelSearchResponse;
  } catch {
    throw new Error(`Parallel.ai search returned invalid JSON: ${responseText.slice(0, 200)}`);
  }

  return {
    hits: (payload.results ?? []).map((r) => ({
      url: r.url ?? "",
      title: r.title ?? "",
      snippet: r.snippet ?? r.content ?? "",
      publishedAt: r.published_at ?? null,
    })),
  };
}
