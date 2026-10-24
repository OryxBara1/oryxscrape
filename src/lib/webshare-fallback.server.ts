/**
 * Third fallback layer: fetch one URL through a country-local Webshare proxy.
 *
 * The Worker runtime's fetch() cannot route through an HTTP proxy, so the
 * request runs inside a single-page Apify crawl configured with the Webshare
 * proxy URL. Only used when the source has an explicit proxy_config — no
 * country is ever guessed from the domain.
 */

import { getDatasetItems, getRun, startCrawl } from "./apify.server";
import { resolveProxyUrls, type ProxySummary } from "./webshare-proxy.server";

export const WEBSHARE_COLLECTOR_VERSION = "webshare-proxy@1.0.0";

const MAX_WAIT_MS = 90_000;
const POLL_MS = 5_000;

export async function extractWithWebshare(
  url: string,
  proxy: ProxySummary,
): Promise<{ text: string; title: string | null }> {
  const proxyUrls = await resolveProxyUrls(proxy);
  const run = await startCrawl({
    startUrl: url,
    maxCrawlPages: 1,
    crawlerType: "playwright:firefox",
    ...(proxyUrls ? { proxyUrls } : {}),
  });

  const deadline = Date.now() + MAX_WAIT_MS;
  let current = run;
  while (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(current.status)) {
    if (Date.now() > deadline) throw new Error("Webshare proxy crawl timed out");
    await new Promise((r) => setTimeout(r, POLL_MS));
    current = await getRun(run.id);
  }
  if (current.status !== "SUCCEEDED") throw new Error(`Webshare proxy crawl ${current.status}`);

  const items = await getDatasetItems(current.defaultDatasetId, 1);
  const page = items[0];
  const text = (page?.markdown || page?.text || "").trim();
  const status = page?.crawl?.httpStatusCode;
  if (status && status >= 400) throw new Error(`Webshare proxy got HTTP ${status}`);
  if (text.length < 200) throw new Error("Webshare proxy returned no extractable text");
  return { text, title: page?.metadata?.title ?? null };
}
