/**
 * Apify client (server-only).
 *
 * Phase 5 uses the generic `apify/website-content-crawler` actor. The token is
 * read from the APIFY_API_TOKEN project secret inside each call and is never
 * logged or returned.
 */

const APIFY_BASE = "https://api.apify.com/v2";

/** Generic crawler actor id in `username~actor-name` form. */
export const DEFAULT_ACTOR_ID = "apify~website-content-crawler";

function token(): string {
  const value = process.env["APIFY_API_TOKEN"];
  if (!value) throw new Error("APIFY_API_TOKEN is not configured");
  return value;
}

async function apify<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${APIFY_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Apify request failed [${response.status}]: ${body.slice(0, 500)}`);
  }
  return (await response.json()) as T;
}

export type ApifyRun = {
  id: string;
  status:
    | "READY"
    | "RUNNING"
    | "SUCCEEDED"
    | "FAILED"
    | "ABORTED"
    | "TIMED-OUT"
    | "ABORTING"
    | string;
  defaultDatasetId: string;
  startedAt?: string;
  finishedAt?: string;
};

export async function startCrawl(input: {
  startUrl: string;
  maxCrawlPages: number;
  actorId?: string;
  /**
   * Lightweight HTTP crawler by default. Hosts that only negotiate legacy TLS
   * cipher suites (e.g. narodne-novine.nn.hr) need the browser crawler.
   */
  crawlerType?: "cheerio" | "playwright:firefox";
  /** Optional link filters so a listing page yields documents, not navigation. */
  includeUrlGlobs?: string[];
  excludeUrlGlobs?: string[];
}): Promise<ApifyRun> {
  const actorId = input.actorId ?? DEFAULT_ACTOR_ID;
  const body = {
    startUrls: [{ url: input.startUrl }],
    maxCrawlPages: input.maxCrawlPages,
    maxCrawlDepth: 1,
    crawlerType: input.crawlerType ?? "cheerio",
    saveMarkdown: true,
    saveHtml: true,
    proxyConfiguration: { useApifyProxy: true },
    ...(input.includeUrlGlobs?.length ? { includeUrlGlobs: input.includeUrlGlobs } : {}),
    ...(input.excludeUrlGlobs?.length ? { excludeUrlGlobs: input.excludeUrlGlobs } : {}),
  };

  const result = await apify<{ data: ApifyRun }>(`/acts/${actorId}/runs`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return result.data;
}

export async function getRun(runId: string): Promise<ApifyRun> {
  const result = await apify<{ data: ApifyRun }>(`/actor-runs/${runId}`);
  return result.data;
}

export type CrawledPage = {
  url?: string;
  loadedUrl?: string;
  markdown?: string;
  text?: string;
  html?: string;
  crawl?: { httpStatusCode?: number; loadedUrl?: string };
  metadata?: {
    title?: string;
    description?: string;
    languageCode?: string;
    canonicalUrl?: string;
    headers?: Record<string, string>;
  };
};


export async function getDatasetItems(
  datasetId: string,
  limit = 100,
): Promise<CrawledPage[]> {
  return apify<CrawledPage[]>(`/datasets/${datasetId}/items?clean=true&limit=${limit}`);
}
