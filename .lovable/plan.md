# French legislation: scheduled date-bounded collection

## What already exists (verified, not assumed)

Most of what this request asks for is already built and running in OryxScrape:

- The source `Légifrance — France` (piste.gouv.fr) exists, is active, and is already marked for weekly collection.
- A working Légifrance/PISTE client already lives in the project: OAuth2 client-credentials against `https://oauth.piste.gouv.fr/api/oauth/token`, with the token cached in memory and reused until just before expiry, and search + document retrieval against `https://api.piste.gouv.fr/dila/legifrance/lf-engine-app`.
- Collection already writes a job record, immutable raw evidence with a SHA-256 content hash and duplicate skipping, and normalization through LogoriOn produces the reviewable items.
- The weekly trigger already exists as a protected endpoint that an external scheduler calls; the French source is included in it.
- The read API `/api/public/v1/items` already serves what has been reviewed and made eligible.

Two things in the request do not match this project and should not be built:

1. **No Supabase Edge Function.** This project's server code runs inside the app itself, not as Supabase Edge Functions. Adding one would mean a second, separately deployed copy of the Légifrance logic, its own copy of the credentials, and its own drift risk. The same schedule and the same behaviour are already available in the existing setup.
2. **The credentials are already stored** as `PISTE_CLIENT_ID` / `PISTE_CLIENT_SECRET` and are in use. No `_ORYXSCRAPE`-suffixed copies are needed.

Several field names in the request also don't exist in our database (`job_type`, `collection_method = 'api_direct'`, `items_found`, `error_message`, `title`, `tier`, `publication_status = 'candidate'`). Our equivalents are already in place and will be used as-is; nothing about the storage shape needs to change.

## What is actually missing

Today the weekly French run searches by concept terms only, capped at 2 results per concept, with no date boundary. So it re-finds the same well-known texts instead of picking up what is newly published. That is the real gap, and it is what this plan fixes.

## Proposed work

1. **Remember the last successful French run.** Take the finish time of the most recent successful French collection job as the lower bound for the next run. First run with no history falls back to a configurable window (default: last 90 days).

2. **Add a date filter to the French search.** Each concept search gains a "published/modified since" bound so only texts newer than the last successful run come back. Sorting switches from relevance to most-recent-first for the scheduled path.

3. **Page through the results properly.** Instead of a hard cap of 2 items per concept, walk the result pages until either the results fall outside the date window, or a safety ceiling is reached (default: 5 pages / 100 documents per concept per run). This protects both the credit budget and the run time.

4. **Also add a plain "recent texts" sweep**, independent of concept terms, so genuinely new French legislation is not missed just because no search term matches it yet. Flagged in the stored evidence as a sweep rather than a concept hit, so provenance stays clear.

5. **Report per run** how many were found, how many were new, how many were duplicates, and how many failed — already recorded on the job, plus the existing Slack alert on failure.

6. **Nothing downstream changes.** Everything collected stays unreviewed and internal-only, exactly as now. Normalization, review, eligibility and the Drive handoff remain human-driven.

## Endpoints used

- Token: `POST https://oauth.piste.gouv.fr/api/oauth/token` (client credentials, scope `openid`) — already implemented.
- Search: `POST /search` on the LODA collection (lois, ordonnances, décrets, arrêtés) — already implemented; gains a date-range filter and date sorting.
- Document retrieval: `POST /consult/lawDecree` per hit — already implemented.

## Pagination

Légifrance returns a page number plus page size and a total count. The scheduled run will request page 1, then continue while: results remain, the page ceiling isn't reached, and the newest-first results are still inside the date window. Every retrieved document is deduplicated by content hash before insert, so overlapping pages are harmless.

## Risks and open questions

- **Date semantics.** Légifrance distinguishes publication date from version date. I'd use publication date as the bound, so an old law that was merely amended doesn't come back every week. Confirm that's what you want, or say if amended texts should also be re-collected.
- **Volume and credits.** An unbounded "recent texts" sweep for France can be large. I propose the 5-page / 100-document per-concept ceiling above and a separate ceiling for the sweep. Tell me if you want different numbers.
- **Scope.** Should the sweep cover all LODA texts, or stay filtered to the maritime/recreational-navigation domain the rest of the project targets?
- **Backfill.** Do you want a one-off catch-up run over a longer window (e.g. the last 12 months) after this ships, or only forward-looking weekly runs?
- **The Auramaris functions being replaced.** You mention 3 manual functions on the consumer side. If they do anything beyond collect/normalize (e.g. their own filtering or classification), tell me what, so nothing is silently dropped.

## Technical notes

- Changes are confined to `src/lib/piste.server.ts` (date filter, sort, pagination) and `src/lib/piste-collect.server.ts` (last-run lookup, paging loop, sweep pass, per-concept stats), plus the French branch of `src/lib/scheduler.server.ts`.
- No database migration is required; the existing `collection_jobs`, `raw_items` and `normalized_items` shapes already cover this, and the run parameters (window start, ceilings, sweep vs concept) are stored on the job's run parameters field.
- On failure the job is marked failed with the error text and the cron endpoint returns HTTP 500 with a JSON body, as it does today.
