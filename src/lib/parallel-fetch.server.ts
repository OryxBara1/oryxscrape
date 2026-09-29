/**
 * parallel-fetch.server — autonomous wrapper for Parallel.ai Extract and Search APIs.
 *
 * Resolves two critical collection gaps in OryxScrape:
 *   1. JS-rendered SPA pages (e.g. DRE Portugal OutSystems): plain server-side fetch
 *      returns a 2 KB empty HTML shell; Parallel renders the page fully and returns
 *      clean markdown with the actual regulatory text.
 *   2. Cloudflare-protected pages (e.g. Légifrance direct URLs): Parallel's
 *      infrastructure handles bot-detection without needing a headless browser.
 *
 * Auth: x-api-key header using PARALLEL_API_KEY environment variable.
 * No Claude in the loop — called directly from cron route handlers.
 *
 * Parallel.ai Extract API docs: https://docs.parallel.ai/extract/extract-quickstart
 * Parallel.ai Search API docs: https://docs.parallel.ai/search
 */

const PARALLEL_EXTRACT_URL = "https://api.parallel.ai/v1/extract";
const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1/search";

export const PARALLEL_COLLECTOR_VERSION = "parallel-extract@1.0.0";
export const PARALLEL_SEARCH_VERSION = "parallel-search@1.0.0";

/**
 * Minimum character count to treat a fetched HTML page as real content.
 * Below this threshold the page is likely an SPA shell bootstrapped client-side.
 */
export const SPA_SHELL_THRESHOLD = 3000;

function getParallelKey(): string {
  const key = process.env["PARALLEL_API_KEY"];
  if (!key) throw new Error("PARALLEL_API_KEY is not configured");
  return key;
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
  excerpts?: string[];
  full_content?: string | null;
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
 *   - Regular HTML pages
 *   - PDFs (use pdf-collect.server.ts for local PDF byte extraction instead)
 *
 * Returns clean markdown text from the rendered page.
 * Throws if Parallel.ai is not configured, the request fails, or the page returns
 * empty content — never silently returns an empty string.
 *
 * @param url          The URL to extract content from.
 * @param objective    Optional natural-language description of what to extract
 *                     (improves excerpt relevance; full_content is always returned).
 */
export async function extractWithParallel(
  url: string,
  objective?: string,
): Promise<ParallelExtractResult> {
  const apiKey = getParallelKey();

  const body: Record<string, unknown> = {
    urls: [url],
    objective: objective ?? "Extract the full text of this regulatory or legal document.",
    advanced_settings: {
      full_content: { max_chars_per_result: 100000 },
      fetch_policy: { timeout_seconds: 60 },
    },
  };

  const response = await fetch(PARALLEL_EXTRACT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
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
    throw new Error(`Parallel.ai extract returned invalid JSON for ${url}: ${responseText.slice(0, 200)}`);
  }

  const result = (payload.results ?? [])[0];
  if (!result) {
    throw new Error(`Parallel.ai extract returned no results for ${url}`);
  }

  // Prefer full_content (entire page from the top); fall back to concatenated excerpts.
  const content =
    result.full_content?.trim() ||
    (result.excerpts ?? []).join("\n\n").trim();

  if (!content) {
    throw new Error(`Parallel.ai returned empty content for ${url}`);
  }

  return {
    text: content,
    title: result.title ?? null,
    publishedAt: result.publish_date ?? null,
    usedParallel: true,
  };
}

/**
 * Returns true when a raw HTTP response body looks like an SPA bootstrap shell
 * rather than rendered document content. Uses character count as the heuristic:
 * a page with fewer than SPA_SHELL_THRESHOLD characters almost certainly needs
 * client-side JavaScript to render its actual content.
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
 * Web search via Parallel.ai — returns LLM-optimized excerpts for each result.
 *
 * Use for autonomous discovery of new regulatory documents without needing
 * Claude in the loop. Call directly from cron route handlers.
 *
 * @param query       Natural-language or keyword search query.
 * @param maxResults  Maximum number of results to return (default 10).
 */
export async function searchWithParallel(
  query: string,
  maxResults = 10,
): Promise<ParallelSearchResult> {
  const apiKey = getParallelKey();

  const response = await fetch(PARALLEL_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
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
