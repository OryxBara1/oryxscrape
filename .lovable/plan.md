# Spain (BOE) collector — plan

Same shape as the French collector: a protected scheduled endpoint inside the app
(`POST /api/public/cron/collect-es-boe`), not a Supabase Edge Function — new Edge
Functions are blocked on this stack, which is why France ended up this way too.

## Answers to your five questions (verified against the live BOE API today)

**1. Endpoints.** Two, both useful and complementary:

- `GET /datosabiertos/api/legislacion-consolidada` — the search endpoint. It accepts a
  JSON `query` parameter with `query_string` (fields `titulo`, `texto`, `materia@codigo`,
  `rango@codigo`, `departamento@codigo`, joined with `and`/`or`/`not`), a `range` block
  for real date filtering (`fecha_publicacion` with `gte`/`lte`), and `sort`
  (`[{"fecha_publicacion":"desc"}]`). Confirmed working: a title search for
  "embarcaciones de recreo" bounded to 2020-2026, newest first, returned the July 2025
  Marina Mercante resolution on private-to-commercial change of use.
- `GET /datosabiertos/api/legislacion-consolidada/id/{id}/texto` — the full consolidated
  text of one norm, as XML blocks. Confirmed 200.
- Optionally `GET /datosabiertos/api/boe/sumario/{AAAAMMDD}` — the daily gazette index,
  covering everything published that day including items never consolidated. See question A.

**2. No registration, no token.** Truly open — every call above succeeded anonymously.
Plain GET over https; POST returns 403. Output format is chosen with the `Accept` header:
search supports JSON, the `/texto` endpoint only answers XML (JSON gives a 400).

**3. Pagination.** Much simpler than Légifrance: `offset` + `limit` on the search
endpoint (default 50). No opaque cursor, no page-token state. We keep your ceiling —
5 pages of 20 per concept, 100 documents per concept per run.

**4. Structural differences that change the approach.**

- *The `from`/`to` top-level parameters filter by last-update date, not publication date.*
  Using them would re-collect every old law that was merely amended. So the date bound
  goes in the `range` block on `fecha_publicacion` instead — same "publication date, not
  version date" decision you made for France.
- *Responses already carry rich metadata* (title, rank, ministry, official number,
  publication date, entry into force, ELI permalink), so unlike Légifrance we don't need
  a second call just to learn the date — one call per norm, only for the full text.
- *The full text is XML, not JSON.* We strip tags per `<bloque>` the way the French
  collector strips article HTML.
- *There are no Spanish terms in the lexicon yet* (`search_terms` has zero `ES` rows),
  whereas France had concept terms to draw on. See question B.
- *BOE is already in the weekly Apify crawl* — it's an active, schedule-enabled source
  with a crawler-based method. See question C.

**5. Canonical URL.** The ELI permalink returned as `url_eli`, e.g.
`https://www.boe.es/eli/es/rd/2022/05/17/376`, with fallback to
`https://www.boe.es/buscar/act.php?id={identificador}` when a norm has no ELI. That's
`source_url` and `canonical_url` in `raw_items`.

## What gets built

1. `src/lib/boe-collect.server.ts` — `runBoeCollection(supabase)`:
   resolve the `boe.es` source; lower bound = `finished_at` of the last successful BOE job,
   90-day fallback; one pass per concept term plus a nautical sweep; per pass, page through
   `offset`/`limit` newest-first until the window is exhausted or the ceiling is hit; for each
   hit fetch `/texto`, flatten to plain text, SHA-256, skip if that hash already exists for
   this source, otherwise insert `raw_items` (immutable, `collection_method: "api"`,
   `language: "es"`, collector version) then `normalized_items` with
   `verification_status: "unreviewed"` and `publication_status: "internal_only"`.
2. `src/routes/api/public/cron/collect-es-boe.ts` — shared-secret protected POST, JSON
   counts back, HTTP 500 with a JSON error body on failure, never a silent empty success.
3. Job bookkeeping identical to France: `running` at start; `succeeded` with
   fetched/new/duplicate/failed counts, or `failed` with the error text; window, ceilings
   and term list recorded in `run_params`.
4. Console logging at each step, and the roadmap updated.

Nothing downstream is touched: no promotion, no eligibility, no Drive handoff, and no
write of any kind outside the OryxScrape schema.

## Questions before building

**A. Daily sumario sweep, yes or no?** Consolidated legislation only covers norms the BOE
documentation service has consolidated, and consolidation lags publication. A once-a-week
walk of the daily sumario for the days in the window (section I, filtered by nautical
keywords in the title) would catch new órdenes ministeriales the moment they appear, at
about 6-7 extra calls per run. I'd include it. Your call.

**B. Where do the Spanish search terms come from?** There are no `ES` rows in the lexicon.
I propose starting with a fixed sweep list in code — "embarcaciones de recreo", "navegación
de recreo", "título náutico" / "licencia de navegación", "puertos deportivos" / "amarre",
"despacho de embarcaciones", "motos náuticas", "seguro de embarcaciones" — and separately
seeding those as `ES` lexicon rows so they show on the Lexicon screen and drive future runs,
exactly like France. Confirm the list, or tell me to seed the lexicon first and read from it
only.

**C. BOE is already collected weekly by the Apify crawler.** Two collectors on one source
will produce overlapping evidence (different hashes, since the crawled HTML and the API text
differ — so dedup won't merge them). Options: (i) switch the BOE source to the API collector
and drop it from the crawler schedule, (ii) keep both, accepting some duplication, or
(iii) register the API collector as a second source row (`boe.es API`). I'd go with (i).

**D. Scope of `rango`.** Restrict to leyes, reales decretos, órdenes and resoluciones, or
accept anything the keyword search returns?

**E. Schedule slot.** France is Monday 03:00 UTC. Same slot for Spain, or staggered?

**F. Backfill** stays parked until 1-2 clean weekly runs, same rule as France — confirm.
