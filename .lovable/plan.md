# Phase 7 — Greece source + weekly scheduled collection

OryxScrape takes over weekly monitoring of the 5 MVP primary sources and adds Greece as the 6th. Only the collection step becomes automatic. Everything after it stays exactly as today.

## 1. Greece (et.gr / ΦΕΚ) — findings

Investigated live, not assumed:

- The modern gazette portal `search.et.gr` is backed by a genuine open JSON API: `POST https://searchetv99.azurewebsites.net/api/simplesearch`, body e.g. `{"selectYear":["2026"],"selectIssue":["2"]}`. Returns HTTP 200 `application/json`; the result array arrives as a JSON string inside the `data` field. No key, no login, CORS-open (send an `Origin: https://search.et.gr` header).
- PDFs live in public Azure Blob storage with a fully predictable, stable URL: `https://ia37rg02wpsa01.blob.core.windows.net/fek/{issue:02}/{year}/{year}{issue:02}{docnum:05}.pdf`. No session tokens or hashes. Wrong padding gives a 404 XML error.
- No anti-bot protection and no legacy-TLS quirk. Plain fetch works, even without a browser user agent. Modern TLS required (fine for us).
- PDFs from 2000 onward carry a real text layer (verified on a 2008 and a 2026 file) — no OCR needed. Pre-2000 issues are scans and would need the LlamaParse fallback.
- The document AuraMaris flagged was located and verified: ΦΕΚ Β' 4559, published 24-07-**2026** (not 2024), `.../fek/02/2026/20260204559.pdf`, 4 pages — ratification of the amendment to General Port Regulation 20, including the inflatable "Θαλάσσια Παιδική Χαρά" definition and the satellite-tracking/remote-control requirement. Exactly the target.
- No mirror of the Greek gazette exists elsewhere worth using; et.gr is the primary and only source.

Implication: Greece is an `api` source (search by year/issue, then direct PDF fetch + text extraction), not a crawler source. It reuses the existing PDF text-extraction path rather than Apify.

## 2. Scheduling mechanism for this stack

Checked what actually exists here:

- The project already ships a cron authentication helper (`src/integrations/supabase/cron-auth.ts`) and the `LOVABLE_CRON_SECRET` value is present in the runtime. So the idiomatic pattern is available today: a public server route protected by that shared secret.
- `pg_cron` and `pg_net` are **available but not yet installed** in this Supabase project (`pg_cron` 1.6.4, `pg_net` 0.20.4). One migration enables both.

Proposed mechanism:

```text
pg_cron (weekly, Mon 03:00 UTC)
   -> pg_net POST https://project--df887a9c-...-dev.lovable.app/api/public/cron/collect
      Authorization: Bearer <LOVABLE_CRON_SECRET>
   -> route authenticates via authenticateCronRequest(), then for every
      source with schedule_enabled = true starts a collection job
      (exactly the same internals the "Run collection" button calls)
```

Apify runs are asynchronous, so collection needs a follow-up pass. Rather than a permanent polling sweeper, two bounded follow-up crons run the same morning (Mon 04:00 and Mon 06:00 UTC) against `/api/public/cron/finalize`, which syncs any still-running job of the day and normalizes what landed. Three scheduled executions per week in total — no continuous polling, negligible recurring cost, worst-case delay for a slow crawl is until the next weekly run, which matches AuraMaris's own weekly rhythm.

Manual triggering stays exactly as it is; the scheduler is an additional caller of the same code.

## 3. Exact changes

**Migration (one, additive)**
- `create extension pg_cron`, `create extension pg_net`.
- `sources`: add `schedule_enabled boolean not null default false`, `schedule_notes text`, `last_scheduled_run_at timestamptz`.
- `cron.schedule` for `oryxscrape-weekly-collect` (Mon 03:00 UTC) and the two bounded finalize passes.
- The cron secret is read from Vault, never inlined.

**New files**
- `src/lib/fek.server.ts` — et.gr `simplesearch` client + blob PDF URL builder.
- `src/lib/fek-collect.server.ts` — collects Greek documents: search by issue/year (and by concept terms from the lexicon where a keyword search applies), fetch PDF, extract text via the existing `unpdf` path, insert `raw_items` with `collector_version = 'etgr-fek-api@1.0.0'`, Apify columns NULL.
- `src/routes/api/public/cron/collect.ts` and `src/routes/api/public/cron/finalize.ts` — secret-authenticated, no PII, no user data returned.
- `src/lib/scheduler.server.ts` — shared loop reusing `startCollectionJob`/`runPdfCollection`/`runPisteCollection`/`runNormalizeJob` internals. No duplicated collection logic.

**Changed files**
- `src/lib/collection.functions.ts` — Greek branch dispatch, no behaviour change for existing sources.
- `src/lib/sources.functions.ts` + Sources screen — a per-source "weekly schedule" toggle (read/write of the new column only).
- `src/lib/normalize.server.ts` — unchanged logic, called from the scheduler too.

**Data**
- One new source row: "Εθνικό Τυπογραφείο — ΦΕΚ (Greece)", `et.gr`, `collection_method = 'api'`, official / primary document / direct URL / government.
- Greek terms added to `search_terms` from the existing multilingual taxonomy (currently 18 terms across 15 concepts, all one country — Greek rows are additive, lifecycle `candidate`).

**First run, targeted hunts (manual, before enabling the schedule)**
- Spain: RD 1188/2025 amending RD 875/2014 (in force 01-10-2026) — via BOE.
- Greece: ΦΕΚ Β' 4559/24-07-2026 — URL already verified above.

## 4. Nothing downstream changes

Confirmed against the code and schema: the scheduler stops at `raw_items` + `normalized_items`. `normalized_items` keeps `verification_status = 'unreviewed'` and `publication_status = 'internal_only'` defaults; no scheduled path writes those columns, calls `setItemReviewState`, touches profile promotion, or calls the Exchange/Drive handoff. Review and handoff remain human-gated clicks. The public read API is untouched.

## 5. Re-collection without re-ingesting unchanged content

`raw_items` already has `UNIQUE (source_id, content_hash)`, and the collectors treat error code 23505 as a duplicate (counted, not failed). So a repeat weekly visit to an unchanged page or PDF inserts nothing and reports a duplicate — this works correctly as-is, no adjustment needed.

One honest caveat to accept or address: the hash covers the extracted text, so a page whose text contains a volatile element (a rendered timestamp, a visit counter) would hash differently each week and create a near-duplicate row. Of our current sources this risk applies mainly to listing pages, not to the documents themselves. Proposal: leave the hashing rule unchanged and watch the weekly duplicate/new counts during the first month; only then decide whether any source needs a normalisation tweak.

## 6. Operational visibility

- Every scheduled run writes `collection_jobs` rows with `run_params.trigger = 'scheduled'`, already visible on the Collection jobs screen; failures keep `error_text`.
- A blocked or failing source (HTTP 403, TLS failure, Apify failure) additionally writes an `audit_events` row so it is queryable and visible on the Audit screen.
- Slack: two workspace Slack connections ("Auramaris Lovable") already exist but are **not linked to this project**. Proposal: link one and post a single weekly summary message plus an immediate alert per failed/blocked source. Nothing is built from scratch. If you prefer no Slack for now, the audit log + jobs screen already carry the information.

## 7. Test plan

1. Greece client: search 2026 issue Β returns results; PDF URL builder produces the verified 4559 URL; wrong padding handled as a clean error.
2. Greek collection of ΦΕΚ Β' 4559/2026 → one `raw_items` row with real Greek text, normalized through LogoriOn, left unreviewed/internal_only.
3. Re-run the same collection immediately → 0 new, 1 duplicate; no second raw row.
4. Spain RD 1188/2025 hunt → found and normalized, or reported honestly as not found.
5. Cron route auth: no bearer → 401; wrong bearer → 401; correct bearer → 200 and jobs created.
6. Dry run of the weekly pass with schedules enabled on two sources only, verifying job rows, duplicate counts, and that no `normalized_items` row changed review/publication state.
7. Failure path: temporarily point one source at an unreachable URL, confirm the job is marked failed with `error_text`, an audit row exists, and (if Slack is approved) an alert fires.
8. Full weekly pass across all 6 sources, then a second pass a week later to confirm dedup behaviour over time.

## 8. Open questions for you

1. **Slack**: link the existing "Auramaris Lovable" Slack connection for failure alerts, or keep visibility in-app only for now? If Slack, which channel?
2. **Greek scope per weekly run**: monitor only ΦΕΚ Β' (regulatory issue) or also Α' (laws)? And how far back should each weekly run look — current year only, or a rolling window of recent issues?
3. **Schedule ownership**: enable weekly scheduling for all 6 countries at once, or start with Greece + Spain for two weeks and then extend?
4. **Croatia's 7 per-act sources**: those are fixed historical consolidations that will never change. Leave them off the schedule (my recommendation) or include them?
5. **Environment target for the cron URL**: preview (`-dev`) or published project URL?
6. **Pre-2000 Greek scans**: out of scope for now (no OCR in the scheduled path), confirm.
