# Runbook — First controlled real test, Phase 1B step 3a (originals storage)

Status: RUNBOOK ONLY. Nothing in this document has been executed. `ORIGINALS_STORAGE_MODE` stays absent/off until the owner starts step R3.

## 0. State verified for this runbook (read-only, 2026-11-04)

- `document_copies` = 0, `document_copy_sightings` = 0, `document_extractions` = 0, bucket `document-originals` = 0 objects.
- `raw_items` = 1210, `normalized_items` = 928, `collection_jobs` = 282 (re-read immediately before the run; these numbers will drift with the weekly crons).
- Two old jobs still `running`, not to be touched: `ba25b0f9-3c8e-4991-b7a8-6ff82f40d8ab` (source `366f2ade-…`, 2026-10-24) and `976ff78f-f8c2-44a1-87bd-4d0961df1ec7` (source `cfd71afa-…`, 2026-09-29).
- No triggers on `raw_items`, `collection_jobs`, `sources`, `document_*`, `normalized_items`.
- `sources` unique key: `(domain, start_url)`. No `is_test` column exists; test identity is carried by a fixed id + name + notes.

## 1. Test document

- URL: `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf`
- Why: published by W3C as a public accessibility test fixture, unchanged for many years, no personal or regulatory content, served directly as `application/pdf` (no app shell, no login, no redirect chain expected), has a real text layer ("Dummy PDF file"), about 13 KB — far below every cap.
- Expected size and hash: NOT known to me and NOT asserted here. They must be obtained in one of two ways (owner chooses):
  - R1-a (preferred, separate authorization): owner, from their own machine, runs one download and records `Content-Length`, actual byte count and SHA-256 (`curl -sSL -o dummy.pdf <URL>; wc -c dummy.pdf; shasum -a 256 dummy.pdf`). These values become the "known hash" checked after the run.
  - R1-b: no prior download; the run itself records the hash, and the owner verifies it afterwards by an independent local download. Weaker: the reference is taken after the fact.
- Acceptance band for size: 5 000 – 100 000 bytes; outside it, stop before R4.

## 2. Test source (created by the owner/agent only at R2, after authorization)

| field | value |
|---|---|
| id | `3a0e5ca1-0000-4000-8000-0000000003a1` (fixed, pre-chosen) |
| name | `TEST 3a originals — do not schedule` |
| domain | `www.w3.org` |
| start_url | the URL in section 1 |
| collection_method | `http` |
| is_active | `true` (required: the manual run refuses inactive sources) |
| schedule_enabled | `false` |
| proxy_config | `NULL` (no Webshare possible) |
| apify_actor_id | `NULL` |
| notes | `TEST:phase1b-3a-originals:2026-11` |
| is_official_domain / is_primary_document | `false` / `false` |
| traceability_level / institution_class | defaults (`untraceable` / `unknown`) |

Insert is one SQL statement executed after authorization; verified afterwards with section 8 query Q1.

## 3. Settings (owner sets them in Lovable → Project Settings → Secrets)

Current state: both absent.

Preferred variant (local extraction):
- `ORIGINALS_STORAGE_MODE=test`
- `ORIGINALS_INLINE_EXTRACT_MAX_BYTES=1048576` (1 MiB; covers a ~13 KB file with margin and still keeps large PDFs out of the Worker parser).

Alternative variant (no local extraction):
- `ORIGINALS_STORAGE_MODE=test`
- `ORIGINALS_INLINE_EXTRACT_MAX_BYTES` absent (= 0).

Return to previous state (R7): delete both secrets (absent = `off` and cap 0). Never type `on`. A value with a typo (e.g. `tset`) reads as `off`, which is safe but means the test silently does nothing — check run_params afterwards.

Open point: whether a changed secret takes effect in the published app without a new publish is not verified. R3 includes checking it (section 8 Q0 cannot read secrets; the proof is the job's `run_params.originals` field, present only when storage was active).

## 4. Proof the scheduler will not pick the test source (checked against code and the live configuration)

1. Mode logic (`src/lib/originals-mode.ts`, `shouldStoreOriginals`): with `test`, storage is enabled only when trigger is `manual` AND `storeOriginals === true`.
2. The only scheduled caller of the PDF collector (`src/lib/scheduler.server.ts`, `collectOne`, http branch) calls `runPdfCollection` without `trigger` or `storeOriginals`; the collector defaults trigger to `scheduled`. So even if the scheduler ran this source, nothing would be stored.
3. The generic scheduler selects only `sources` with `schedule_enabled = true AND is_active = true`; the test source has `schedule_enabled = false`.
4. Live cron jobs (9, all active) target only fixed routes: `collect-fr-legifrance`, `collect-eu-eurlex`, `collect-it-normattiva`, `collect-es-boe`, `collect-hr-nn`, `collect-uk-legislation`, `collect-nl-obk`, `collect-gr-fek`, `collect-gi-laws`. None targets the generic `/api/public/cron/collect` or `finalize`. The GR and GI routes load fixed source ids; the others call country collectors that do not read the `sources` table by method.
5. Remaining exposure: a person calling `/api/public/cron/collect` with the cron secret would run the generic scheduler — which still excludes this source (point 3) and could not store originals (point 2).

## 5. The manual operation

Call `startCollectionJob` (staff session) with:

```json
{ "sourceId": "3a0e5ca1-0000-4000-8000-0000000003a1",
  "documents": [{ "url": "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", "document_label": "TEST 3a dummy.pdf" }],
  "storeOriginals": true }
```

Gap found: the current screens never send `storeOriginals`. Two ways to issue the call, owner decides (each needs its own authorization):
- M-A: the agent invokes the server function directly with the owner's staff session. Requires confirming that call reaches the environment where the secret is set.
- M-B: a small staff-only "store original (test)" checkbox on the manual run form, shown only when the mode is `test`; requires a code change, tests and a publish.

Exactly one call, one URL. No retry without a new decision.

## 6. External calls and cost

Preferred variant (cap 1 MiB), success path — bounded:
- 1 GET to w3.org (free).
- Storage: 1 upload + 1 verification download of ~13 KB to the private bucket; text is under 1 MiB so it goes inline in the extraction row (no text object).
- Database: about 8–10 small statements.
- Parallel / Webshare / Apify: 0 calls. Resend: 0.
- Cost: negligible (Supabase storage/egress for ~26 KB).

Conditional paid fallback (both variants): if the direct GET fails (non-404), the response is not a PDF/is short HTML, the read times out (60 s), or (alternative variant) the inline cap is 0 → exactly 1 Parallel Extract call. No Webshare (no proxy_config). If Parallel also fails → 1 blocked record + 1 Resend alert to ops@auramaris.app from OryxScrape's own account. Upper bound: 1 Parallel call + 1 email. Parallel per-request price is not verified here; it is a single request at their extract rate.

Alternative variant (inline = 0): Parallel is called by design (1 call, paid). Stored copy is still the direct bytes; Parallel text goes only to the raw_item, never to an extraction row; `original_storage.inline_extract = skipped_cap`, attempts `inline_pdf:inline_extract_cap` then `parallel`. Raw text and content_hash may differ from what local extraction would give. No `document_extractions` row.

## 7. Expected records and objects

Mandatory (preferred variant):
- 1 `sources` row (section 2), created at R2.
- 1 `collection_jobs` row, `status=succeeded`, `run_params.method=http-pdf`, `run_params.originals` present.
- 1 `raw_items` row for the test source (or 0 + duplicate count if identical text already exists — not expected).
- 1 `document_copies` row: `storage_status=verified`, `size_bytes` = known size, `file_sha256 = sha256:<known hash>`, `storage_path = sha256/<hh>/<hash>`, bucket `document-originals`.
- 1 Storage object at that exact path.
- 1 `document_copy_sightings` row linking copy, raw_item, source, job; `byte_outcome=stored`, `fetch_method=http`.
- 1 `document_extractions` row: `extractor_version=unpdf@1.8.1`, `text_inline` set, `text_storage_path` null, `truncation_status` complete.

Conditional:
- Alternative variant: no extraction row; Parallel attempt recorded.
- Fallback/blocked path: blocked raw_item + email as in section 6.

Never created: legal documents, document versions, approvals, normalized_items (normalization is a separate manual step, not part of this run), text objects in Storage.

## 8. Verification queries (read-only)

- Q0 (before, R2-pre): counts of `raw_items`, `normalized_items`, `collection_jobs`, `document_copies`, `document_copy_sightings`, `document_extractions`, objects in `document-originals`; `max(created_at)` per table; status of the two old running jobs; list of cron jobs/paths.
- Q1: test source row by id — `schedule_enabled=false`, `is_active=true`, `proxy_config IS NULL`.
- Q2 (after): the new job by `source_id` — status, `error_text`, `run_params->'originals'`, `finished_at`.
- Q3: copy by `file_sha256 = 'sha256:<known>'` — size, status, path; path equals `sha256/`+first 2 hex+`/`+hex.
- Q4: Storage object at that path exists, size matches; object count = 1.
- Q5: sighting and extraction join back to the same copy id, the new raw_item and the new job.
- Q6: every row created since Q0 belongs to the test source/job (diff counts must equal section 7); rows existing at Q0 unchanged (same counts, no `updated_at` after run start outside the test ids); two old jobs unchanged.
- Q7: independent hash check — owner downloads the object via a 300 s signed link (or compares with R1-a) and computes SHA-256.

## 9. Stop criteria (stop, set mode back, report; no retry)

- Worker memory error or crash; read/upload/verify/150 s timeout.
- `storage_status` not `verified`, hash or size differs from known values, existing copy with the same hash but different size.
- Any write outside section 7 (Q6 mismatch), any change to earlier records or the two old jobs.
- A Parallel/Webshare/Apify call in the preferred variant (unplanned fallback), or more than 1 Parallel call in the alternative.
- Any `run_params.originals` on a job not created by the R4 call, or any new `document_copies` row while the mode is meant to be off.

## 10. Shutdown

1. Owner deletes `ORIGINALS_STORAGE_MODE` and `ORIGINALS_INLINE_EXTRACT_MAX_BYTES`.
2. Confirm: next job of any source has no `run_params.originals` (passive check; no run started for it).
3. Optionally set the test source `is_active=false` (owner decision; it is a state change, not a deletion).
4. Record and keep: source id, job id, raw_item id, copy id, sighting id, extraction id, Storage path, hash, size. Nothing deleted; append-only untouched.

## Execution order (each step needs the owner's go)

```text
R1 obtain size/hash (R1-a or R1-b)  ->  R2 Q0 + create source + Q1
R3 owner sets secrets               ->  R4 single manual call (M-A or M-B)
R5 Q2-Q7                            ->  R6 stop-criteria review
R7 shutdown (section 10)
```

Decisions needed: R1-a vs R1-b; preferred vs alternative variant; M-A vs M-B for the call.
