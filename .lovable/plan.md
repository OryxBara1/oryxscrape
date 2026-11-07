# Slice (b): start ONE manual collection from an approved, linked candidate

Scope: one button that starts one collection for one candidate, through the current `startCollectionJob` path. No collector changes, no originals, no schedules, no retry. Slice (c) (choose raw_item, stage=collected) stays out: `raw_item_id` and `stage` are never written here.

## Verified now
- [V] Candidate `aeb72796…`: approved_for_collection / open / needs_review=false / source_id=`b3440053…` / collection_job_id NULL / raw_item_id NULL / retrieval_state `none` / updated_at `2026-11-07 01:30:07.491297+00`.
- [V] Source `b3440053…` has no collection_jobs and no proxy_config (so Webshare can never run for it).
- [V] retrieval_state CHECK: none, in_progress, access_failed, not_found, awaiting_retry. FKs: candidate.collection_job_id → collection_jobs, collection_jobs.source_id → sources (RESTRICT). The guard trigger does not protect retrieval_state / collection_job_id / raw_item_id (app-only rules, as in slices a/triage).
- [V] job_status enum: queued, running, succeeded, failed, cancelled, diagnostic.
- No migration needed.

## 1. Server preconditions (new `startCandidateCollection`, staff-only, user's own client)
Re-read candidate and source in the handler; refuse unless all hold:
- candidate: stage `approved_for_collection`, outcome `open`, needs_review false, source_id set, collection_job_id NULL, raw_item_id NULL, retrieval_state `none`.
- `access_failed`, `not_found`, `awaiting_retry`, `in_progress`: refused in slice (b) (no retry path; recovery only per section 3).
- source: `collection_method='http'`, is_active, schedule_enabled=false, `collectionRouteOf(source)==='http'` (the shared rule from slice a).
- no job for this source in `queued` or `running` (the three stuck jobs are on other sources and are not read or touched).
- URL pair: if `source.start_url !== candidate.confirmed_source_url` (exact string), require `confirmUrlPair: {startUrl, confirmedUrl}` in the request, equal to the current rows. Link-time confirmation is not reused. Cap. 283: URLs are equal, so no extra confirmation.
- Client sends only: candidateId, expectedUpdatedAt (exact string read), optional confirmUrlPair. Nothing else is accepted.

## 2. Duplicate protection (claim)
Guarded UPDATE as the user:
`SET retrieval_state='in_progress', reviewed_by=context.userId, reviewed_at=server now`
`WHERE id=? AND updated_at=<exact original> AND stage='approved_for_collection' AND outcome='open' AND needs_review=false AND source_id=<read> AND collection_job_id IS NULL AND raw_item_id IS NULL AND retrieval_state='none'` returning id, updated_at.
- Zero rows → conflict, nothing started, no retry.
- Only the winner calls `startCollectionJob`. A second concurrent request loses the compare (updated_at changes via trigger and state is no longer `none`).
- `reviewed_at` of the claim is the anchor time for recovery lookups.

## 3. Operation sequence and failures
```text
claim (none→in_progress) → startCollectionJob({sourceId}) [no documents override, no storeOriginals]
  → returns jobId → finalize UPDATE (collection_job_id IS NULL, retrieval_state='in_progress', updated_at=claim value)
```
`runPdfCollection` inserts the job itself and only returns `jobId` at the end, so the candidate cannot know the job until the call returns.

| Case | State left | Human recovery |
|---|---|---|
| Claim ok, call throws before job insert (source changed, DB error) | in_progress, job NULL | "Check for a job": lists jobs with source_id=this source and created_at ≥ claim time. If none, "Release claim" (in_progress→none, guarded, job NULL). |
| Job created, finalize UPDATE fails / conflicts | in_progress, job NULL | Same lookup shows the job; human clicks "Link this job" (guarded: job.source_id matches, created ≥ claim, not linked to any other candidate, candidate job NULL). Release is refused while such a job exists. |
| Timeout / connection lost, job state unknown | in_progress, job NULL; job may be running, finished, or stuck in `running` | Same lookup; human links it when visible. A stuck job is shown as is, never edited or cancelled here. |
Never: auto-link, blind retry, a second job, deletes, or editing collection_jobs.

## 4. Traceability (finalize write, explicit columns only)
- `collection_job_id = jobId` only when currently NULL (guarded); never overwritten.
- `retrieval_state`: `none` if ingested or duplicate (=bytes retrieved, waiting for slice c); `not_found` if the target failed with HTTP 404/410; `access_failed` for any other target failure. `awaiting_retry` unused.
- `reviewed_by/at` = server identity/clock. `raw_item_id`, `stage`, outcome, lead/key fields untouched.
- Because start requires `collection_job_id IS NULL`, a linked candidate can never start again in slice (b).

## 5. What the real run does (originals OFF, `ORIGINALS_STORAGE_MODE` absent)
`startCollectionJob`: not transport.gov.mt, method http → `runPdfCollection` with target `source.start_url`, trigger manual, storeOriginals resolves false.
1. Inserts collection_jobs row (`running`, run_params `{method:"http-pdf", targets}`).
2. Direct `fetch` (follow redirects).
3. If fetch fails (network or non-2xx): **one Parallel Extract call**; if empty/failed and no proxy (true here) → error → blocked record + Resend alert to `ops@auramaris.app` (for 401/403/407/429/5xx/network/timeout/no-text). 404 is not "blocking": target counted failed, no blocked row.
4. If 2xx: `arrayBuffer()`; PDF if content-type contains "pdf" or bytes start `%PDF` → unpdf text layer. Empty text → "no extractable text layer" → blocked + alert, **no Parallel**.
5. Non-PDF response: HTML text ≥1000 chars stored as HTML; shorter → **one Parallel call** (SPA shell); empty → blocked + alert.
6. raw_items insert: content_hash = SHA-256 of extracted text; UNIQUE(source_id, content_hash) → 23505 counted duplicate.
7. No document_copies / sightings / extractions / Storage (originals off). Job → `succeeded` with counts (even when the target failed, failed_count=1), or `failed` on unexpected errors.
So: Parallel max 1 call, only on fetch failure or short-HTML. Cost of that call: unknown price (accepted earlier as not a blocker).

## 6. UI (`discovery-candidate-panel.tsx` + new `discovery-collection-start.tsx`)
- Section visible only when preconditions pass: shows candidate title, source name/id, start_url and confirmed URL (pair checkbox only if they differ).
- "Start one collection" → confirmation dialog → one POST. Button disabled while pending.
- After: show jobId, job status/counts (read on load or manual "Refresh", read-only).
- In_progress without job: "Check for a job", "Link this job", "Release claim".
- No run on mount, no polling that writes or starts anything; reload only reads.

## Files
- `src/lib/discovery-collection.ts` (new, pure rules: preconditions, URL pair, result → retrieval_state, recovery eligibility).
- `src/lib/discovery.functions.ts`: `startCandidateCollection`, `findCandidateJobs`, `linkCandidateJob`, `releaseCandidateClaim`; detail loads job status.
- `src/components/discovery-collection-start.tsx` (new), `discovery-candidate-panel.tsx`.
- `src/lib/discovery-collection.test.ts` (new); `roadmap.md`.
- Not touched: `collection.functions.ts`, `pdf-collect.server.ts`, collectors, scheduler, originals, sources functions.
- Calling `startCollectionJob` from another server function: done server-side within the same request (auth middleware sees the same headers). If that proves unworkable, STOP and report; do not reimplement routing.

## Mock tests
Staff required before any write; each precondition refused with no write; awaiting_retry/access_failed/not_found/in_progress refused; URL mismatch needs exact fresh pair; claim compare uses exact updated_at; two concurrent starts → one call; zero-row claim → no start; startCollectionJob called once with only `{sourceId}` and no storeOriginals; throw before job → in_progress/NULL; finalize conflict → no overwrite; result mapping (ingested/duplicate→none, 404→not_found, other→access_failed); link-job guards (source, time, already linked); release refused when a job exists; payload columns explicit; raw_item_id/stage never written; browser cannot set reviewer. Existing 198 stay green.

## Not proven without real DB
RLS on the guarded updates, real concurrency of two claims, Worker timeout behaviour mid-run, actual fetch/parse of legislation.mt, whether Parallel is called, alert delivery.

## Acceptance (Cap. 283, needs your go-ahead; writes real rows, may cost ≤1 Parallel call)
1. Open the candidate; check the shown URL equals the source start_url.
2. Click "Start one collection", confirm once.
3. Expect a job linked, retrieval_state per result; check Jobs page for exactly one new job on this source.
4. Reload: nothing starts; button gone.
5. Before/after queries: candidate row, `collection_jobs where source_id='b3440053…'`, `raw_items where source_id=…`.

## Blockers
None in schema. Open point: server-to-server call of `startCollectionJob` (stop and report if it fails).
