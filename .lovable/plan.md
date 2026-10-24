# Proxy support for geo-restricted sources (Webshare, GR)

## Corrections to the proposal
- **No Edge Function.** Project rule: server logic lives in TanStack server-only modules (Edge Functions were retired). The resolver becomes `src/lib/webshare-proxy.server.ts`.
- **RLS applies to tables, not functions.** The new column inherits the existing `sources` RLS (staff-only). No new table, so no new policies. The resolver is server-only and never exposed as a route.
- **Preview branch:** this project uses an external Supabase; my migration tool applies to the connected database. I cannot target a `feat/proxy-config` branch myself. Options: (a) you run the SQL on the branch yourself, or (b) you switch the connected project to the branch first. The change is additive and nullable, so it is low-risk either way.
- **Greek collector does not use Apify.** The FEK (et.gr) collector fetches the search API and PDFs with plain `fetch`. Proxying only Apify would not fix it. Also, Cloudflare Workers `fetch` cannot route through an HTTP proxy. See Open questions.

## Migration SQL
```sql
ALTER TABLE public.sources ADD COLUMN proxy_config jsonb NULL;
ALTER TABLE public.sources ADD CONSTRAINT sources_proxy_config_shape CHECK (
  proxy_config IS NULL OR (
    proxy_config->>'type' = 'webshare'
    AND proxy_config->>'country_code' ~ '^[A-Z]{2}$'
    AND NOT (proxy_config ? 'username') AND NOT (proxy_config ? 'password')
  )
);
```
The check blocks anyone storing credentials in the column.

## Files
- **New `src/lib/webshare-proxy.server.ts`** — `getProxyUrl(config)`: validates config, calls `GET https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&country_code=GR&page_size=25` with `Authorization: Token <WEBSHARE_API_KEY>`, picks one valid proxy at random, builds `http://user:pass@ip:port` from secrets. Throws `WebshareProxyError` on missing secret, non-2xx, empty list. Error messages never include the URL or credentials.
- **`src/lib/apify.server.ts`** — `startCrawl` accepts optional `proxyUrls`; when set sends `{ useApifyProxy: false, proxyUrls }`, otherwise keeps current `{ useApifyProxy: true }`. Same option for the sync helper used by Malta.
- **`src/lib/collection.functions.ts`** — select `proxy_config`; if present, resolve proxy before creating the Apify run. Resolver failure marks the job `failed` with `error_text: "Proxy resolution failed: <reason>"` and rethrows.
- **`src/lib/scheduler.server.ts`** — same wiring for scheduled Apify runs.
- **`run_params`** records only `{ proxy: { type, country_code } }` — never the URL.
- **`src/integrations/supabase/types.ts`** regenerates.
- **Sources page** — read-only "Proxy: GR" badge (editing via SQL for now).
- **Test** `webshare-proxy.server.test.ts`: throws on 401, on empty list, on missing secret; URL built correctly with mocked fetch; error text contains no password.

## Risks
- Apify run input is visible in the Apify console/run storage, so the proxy credentials are stored at Apify. Mitigation: use a Webshare sub-user dedicated to this purpose; rotate if needed.
- Webshare default `page_size=1` always returns the same IP; random choice from 25 spreads load.
- Unknown actors may ignore `proxyConfiguration` (website-content-crawler supports it).

## Open questions
1. Which sources are Greek-restricted, and are they Apify-based? FEK is direct `fetch`; proxying it would require routing those fetches through an Apify actor (or another proxy-capable runner), since Workers cannot use HTTP proxies.
2. Who applies the migration on `feat/proxy-config` (you, or switch the connection)?
