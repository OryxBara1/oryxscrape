# Plan — link an approved candidate to a source and a manual collection

Labels: [V] verified this turn (code or read-only query), [E] reported earlier, [N] not tested. Nothing here is implemented. No migration is proposed.

## 0. How it works today
- **Sources** [V]: `createSource`/`updateSource` in `sources.functions.ts` accept any insert/patch object from the browser (no explicit allowlist). `sources.collection_method` is `NOT NULL DEFAULT 'apify'`, and the Sources form does not set it, so a new source becomes an Apify crawl by default (the trap). `schedule_enabled` defaults to false; the weekly scheduler runs only `schedule_enabled = true AND is_active` sources. Unique `(domain, start_url)`. Insert/update need staff (RLS); delete is owner-only.
- **Manual start** [V]: `startCollectionJob({ sourceId, documents?, storeOriginals?, … })` reads the source and branches:
  - start URL containing `transport.gov.mt` → Malta chain (ignores the candidate URL unless passed in `documents`).
  - `api` → per-domain collector (whole feed, ignores the candidate URL).
  - `http` → `runPdfCollection` with `documents[].url` (or the source start URL) — the only path that fetches an exact URL.
  - otherwise (apify) → crawl of `source.start_url`, not the candidate URL.
- **Jobs → raw_items** [V]: `raw_items.job_id` → job; unique `(source_id, content_hash)`. A re-fetch with the same content counts as a duplicate and creates no new raw item in the new job, so a succeeded job can have zero rows of its own.
- **Candidate columns** [V/E]: `source_id` → sources, `collection_job_id` → collection_jobs, `raw_item_id` → raw_items (all nullable FKs, not protected by the guard trigger). `retrieval_state` CHECK: none, in_progress, access_failed, not_found, awaiting_retry.
- **Originals** [E]: preserved only on the `http` path, manual run, `ORIGINALS_STORAGE_MODE=test` and the box ticked. It is off (variable absent) and stays off.
- Existing data [V]: two `http` legislation.mt sources (Cap. 234 start URL; the 3a TEST source). Banking Act candidate is `source_located` and is not touched.

## 1. Actions and transitions (all on approved candidates, app-enforced)
```text
approved_for_collection, source_id NULL
  --link_source(existing id)  or  create_source_and_link (explicit)-->  source_id set
  --start (existing startCollectionJob, separate click)-->  collection_job_id set, retrieval_state in_progress
  --record_result (human picks the matching raw item)-->  raw_item_id set, retrieval_state none, stage collected
```
- **Link existing source**: human picks from a list filtered to `http`, active, `schedule_enabled=false`; no domain auto-match. Confirm screen shows candidate URL plus source name, domain, start URL, method, active, schedule, proxy flag.
- **Create source**: explicit form with method fixed to `http` (sent explicitly, never the DB default), `schedule_enabled=false`, start URL = confirmed source URL exactly, and the existing required fields typed by the human. If `(domain, start_url)` already exists → no insert; show that source and offer "link existing".
- **Unlink source**: only while `collection_job_id` is NULL; sets `source_id` NULL. The source row is never deleted.
- **Start**: separate button; calls the existing `startCollectionJob({ sourceId, documents: [{ url: confirmed_source_url }] })`, never `storeOriginals`. Blocked if a job is already linked and not finished.
- **Withdraw approval** (existing): allowed only while no job is linked; afterwards the button is hidden with an explanation. Links are never cleared silently.

## 2. Why `http` only in this slice
`http` fetches exactly the confirmed URL. Direct PDF → text layer; HTML → at most one Parallel fallback, then Webshare if configured, then blocked record + alert to `ops@auramaris.app` [E]. Apify and api ignore the candidate URL, so they are marked incompatible. Originals remain off; the start call never sends `storeOriginals`.

## 3. Duplicates and concurrency
- Every candidate update: `id` + exact original `updated_at` + `stage='approved_for_collection'` + `outcome='open'` + expected `source_id`/`collection_job_id` (NULL or value). Zero rows = not applied, conflict message, no retry. Staff check before any write; `reviewed_by`/`reviewed_at` from server.
- Start uses a claim: guarded update `retrieval_state none → in_progress` (with `collection_job_id IS NULL`) **before** calling `startCollectionJob`; only the winner starts. Then a guarded update writes `collection_job_id`. If start throws: `retrieval_state = access_failed`, no job id (any failed job row stays as history). Stuck claim (tab closed): manual "release claim" back to `none` only if no job is linked.
- Source duplicates: unique `(domain, start_url)` [V].

## 4. Traceability and "collected"
- `source_id` = where to collect; `collection_job_id` = the run started for this candidate; `raw_item_id` = the one raw row the human confirms is this document.
- Result view lists raw items with `job_id = collection_job_id` and the same source rows matching the confirmed URL (to show duplicates from earlier runs).
  - zero rows: job failed → `access_failed`; succeeded with only duplicates → show the earlier matching row; nothing → `not_found`.
  - one or many rows: human picks one; nothing is auto-chosen.
- `stage = collected` only on the explicit "record result" action with a chosen raw item from the same source whose `source_url` equals the confirmed URL. Job `succeeded` alone never sets it. `reviewed_copy` (review of the copy) is out of scope and stays separate.
- Failure: human may set `awaiting_retry`; a new start needs a fresh claim and replaces `collection_job_id` — the previous job id is lost from the candidate (still in `collection_jobs`). Gap G1 below.

## 5. Explicit payload columns
- link/unlink: `source_id`, `reviewed_by`, `reviewed_at`.
- claim/start result: `retrieval_state`, `collection_job_id`, `reviewed_by`, `reviewed_at`.
- record result: `raw_item_id`, `stage`, `retrieval_state`, `reviewed_by`, `reviewed_at`.
- create source: explicit allowlist (name, domain, start_url, collection_method='http', schedule_enabled=false, is_active, the required classification and tos/robots columns) via a new staff-only function, not the open `createSource`.
- Never: lead fields, keys, outcome*, needs_review, review_note, confirmed_*, confidence, outcome_history.

## 6. Files
- `src/lib/discovery-collection.ts` (new): rules, guards, patch builders.
- `src/lib/discovery.functions.ts`: `linkCandidateSource`, `createSourceForCandidate`, `unlinkCandidateSource`, `claimCandidateStart`, `recordCandidateJob`, `releaseCandidateClaim`, `recordCandidateResult`.
- `src/components/discovery-collection-panel.tsx` (new) + panel mount; approval form hides withdraw once a job is linked.
- Tests: `src/lib/discovery-collection.test.ts`. Collection, scheduler, originals and sources files are not changed.

## 7. Mock tests
Link only when approved/open; incompatible source (apify, api, inactive, scheduled) refused; no auto-match; create sends method `http` and schedule false explicitly, duplicate `(domain,start_url)` → no insert; linking never calls start; double claim → one winner; stale token → conflict, no write; start error → access_failed; job succeeded ≠ collected; collected requires chosen raw item from same source and URL; zero/many results; withdraw blocked with job; unlink blocked with job; `storeOriginals` never sent; patch keys exact; non-staff refused before write; reviewer from server.

## 8. Risks and real gaps
- G1: one `collection_job_id` per candidate: retries overwrite the link (old jobs remain in `collection_jobs`, not linked). History would need a migration; not proposed now.
- Claim/start/record are three steps; a browser crash between them leaves `in_progress` (release action covers it).
- Rules live in the app; staff could write directly.
- HTML pages can spend one Parallel call; cost is unknown [E].
- Not proven without real DB: RLS on these updates, FK behaviour, unique conflict code, real concurrency, real collection.

## 9. Constraints
No trust promotion, no provider text, nothing shared with consumer apps, user's own client, server-side reviewer, explicit columns, no schedule, originals off.

## 10. Future acceptance candidate
Carriage of Goods by Sea (Regulation) Act, Malta, `https://legislation.mt/eli/cap/283/eng`, candidate `aeb72796-3e7c-487d-8aac-52b2963f3d4b` (lead/open) [V]. The URL is an HTML page, so the run may use one Parallel call at unknown price — this needs separate approval. Linking to the existing Cap. 234 source is not suitable, because its start URL differs and duplicate checks are per source; a new `http` source for the Cap. 283 URL would be created by explicit action.
