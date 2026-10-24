# Greek 403 fallback to Parallel.ai + Webshare proxy support

## What changes for you
- Greek pages that answer "403 / blocked" (e.g. E-Nomothesia) are retried through Parallel.ai before landing in the Manual Upload Queue.
- Apify-based sources can later be routed through a Greek Webshare IP once the `proxy_config` column exists. Nothing changes for current sources.

## Change 1 — `src/lib/pdf-collect.server.ts`
- Direct fetch stays first; short-HTML (<1000 chars) Parallel fallback unchanged.
- Fetch errors (HTTP 403/429/5xx, timeouts, DNS/connection failures) now call `extractWithParallel(url, ...)` inside the per-target loop before giving up.
  - Success: content = Parallel text, `usedParallel = true`, normal insert (`collector_version = parallel-extract@1.0.0`, `extraction_method: "parallel_extract"`). `http_status` stores the original failing status; `content_type` null.
  - Parallel fails or returns empty: same path as today (`recordBlockedItem` when `isBlockingError`), with the error text combining both failures, e.g. `HTTP 403; Parallel: <reason>`, so it still matches the blocking regex.
- HTTP 404: no Parallel retry, behaves exactly as today.
- PDF text-layer failures ("no extractable text") are not retried (not an HTTP error).
- No signature/export/caller changes.

## Change 2 — new `src/lib/webshare-proxy.server.ts`
- `export class WebshareProxyError extends Error`
- `export async function getWebshareProxy(countryCode: string): Promise<string>`
  - Validates `countryCode` matches `^[A-Z]{2}$`.
  - Reads `WEBSHARE_API_KEY`, `WEBSHARE_PROXY_USERNAME`, `WEBSHARE_PROXY_PASSWORD` inside the call; missing → `WebshareProxyError("Webshare credentials are not configured")` (names no value).
  - `GET https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&country_code=XX&page_size=25`, header `Authorization: Token ...`.
  - Non-2xx → error with status only; empty `results` → error. Picks a random entry with `valid !== false`.
  - Returns `http://user:pass@address:port`, username/password URL-encoded. Never logs.

## Change 3 — `src/lib/apify.server.ts`
- `startCrawl` gains `proxyUrls?: string[]`; when non-empty → `proxyConfiguration: { useApifyProxy: false, proxyUrls }`, otherwise unchanged.

## Change 4 — `src/lib/collection.functions.ts`
- Current source query lists explicit columns; adding `proxy_config` would break while the column is absent. A second lightweight read `select("*")` on the same source id is used to read `proxy_config` safely: `(row as Record<string, unknown>)?.proxy_config ?? null`.
- Small shared helper `resolveProxyUrls(proxyConfig)` (in the webshare module) returns `undefined` for null/unknown shapes, or `[await getWebshareProxy(cc)]` for `{ type: "webshare", country_code }`.
- Resolution runs after the job row is inserted but before `startCrawl`: on failure the job is updated to `failed` with `error_text: "Proxy resolution failed: <reason>"` and the Apify run is never started.
- `run_params` records only `{ proxy: { type, country_code } }`, never the URL.

## Change 5 — `src/lib/scheduler.server.ts`
- Scheduled sources are already loaded with `select("*")`, so `proxy_config` is read the same safe way and passed through the identical resolve → fail-job / `proxyUrls` chain.

## Test
- `src/lib/webshare-proxy.server.test.ts` (mocked fetch, fake env): missing secret throws; 401 throws; empty list throws; URL is built from env + chosen proxy; error messages never contain the password.

## Constraints honored
- No migrations, no new secrets, no Edge Functions, new file is `.server.ts`.
- Risk unchanged from earlier: proxy credentials are visible in Apify run input; use a dedicated Webshare sub-user.
- Note: Parallel.ai fetches from its own servers; if E-Nomothesia also blocks Parallel, items still go to the Manual Queue (expected, last resort).
