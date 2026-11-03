# Phase 1B — Step 3: storing original files and integrating with the collector

Status: PLAN ONLY. Nothing here is executed until step 3 is authorized separately.
Out of scope: UI, LDH, scheduling, automatic file deletion or destructive reconciliation, the 4 old advisor warnings, exposed-schema settings, any link to another product.

## 0. Closing note for step 2 (goes into roadmap.md when edits are allowed)

- Migration `20261103132927`.
- Private bucket `document-originals`, limit 52428800 bytes, MIME unrestricted.
- One SELECT policy, limited to staff and to this bucket.
- The two test objects were removed; the bucket is empty.
- No new advisor warnings (the 4 old ones unchanged).
- NOT executed: a real HTTP login as staff or non-staff, and a direct write attempt as staff. The database simulation and the service_role signed link do not replace those tests. "No write policies" is a configuration we observed, not a functional test we ran.

## 1. What the code does today (read from the source)

Every collector writes only `raw_items`. No code writes to the `document_*` tables or to Storage yet.

| Path (file → function) | Gets original bytes? | Today it stores |
|---|---|---|
| `pdf-collect.server.ts` → `runPdfCollection`, direct fetch that succeeds (PDF) | Yes: the full PDF in memory (`arrayBuffer()`) | Text from `unpdf` in `raw_payload.plain_text`, plus `byte_length` |
| same, direct fetch that succeeds (HTML ≥ 1000 chars) | Yes: the HTML bytes | Reduced text |
| same, direct fetch succeeds but the page is an empty app shell → Parallel | Yes, but only an empty shell | Parallel text |
| same, direct fetch fails → Parallel Extract | **No**, text only | Parallel text, `extraction_method: parallel_extract` |
| same, → Webshare (Apify single-page crawl) | **No**, markdown/text only from the dataset | Text, `extraction_method: webshare_proxy` |
| same, everything fails → `recordBlockedItem` | No | Blocked row |
| `gibraltar-collect.server.ts` (PDF of an act) | Yes, PDF | Text |
| `gibraltar-collect.server.ts` (text inline on the act page) | HTML of the act page only | Text |
| `fek-collect.server.ts` (ΦΕΚ PDF) | Yes, PDF | Text |
| `malta-collect.server.ts` → `tryHttp` | Yes, PDF/HTML | Text |
| API collectors (EUR-Lex, Normattiva, BOE, UK, OBK, DOU, PISTE…) | Structured API responses, not document files | Text/JSON |

Callers of `runPdfCollection`: the manual run (`collection.functions.ts:174`) and the scheduler (`scheduler.server.ts:203`).

## 2. What gets stored for each path

Rule: an original is only ever **bytes received from the source**. Text rebuilt by Parallel, Apify or our own HTML reduction is **never** stored as an original.

| Path | Original in Storage | `document_copies` | `document_copy_sightings` | `document_extractions` |
|---|---|---|---|---|
| Direct PDF | Yes | created or reused | `fetch_method=http`, `byte_outcome=stored` or `deduplicated` | `unpdf` text: tool `unpdf`, version from package |
| Direct HTML (full page) | Yes, the HTML file as received | yes | `http` | text from `extractHtmlText`, tool `html-reduce@1` |
| App shell, then Parallel | Store the shell HTML as received (it is what the source served) | yes | `http` | Parallel text recorded as an extraction of that copy, tool `parallel_extract`. It is flagged as not derived from the stored bytes; see Q3 |
| Parallel only (direct fetch failed) | **None** | none | **none** (a sighting needs a copy or `not_stored_size_limit`) | none |
| Webshare/Apify | **None** | none | none | none |
| Over 50 MB | None | none | `byte_outcome=not_stored_size_limit`, `copy_id` NULL | none |
| Blocked | None | none | none | none |

For every path, `raw_items.raw_payload` gets one honest field: `original_storage: { status: "stored" | "deduplicated" | "not_available_text_only" | "not_stored_size_limit" | "failed" | "disabled", copy_id?, error_class? }`. Text-only paths say `not_available_text_only` and are never described as having an original.

A sighting records: `fetched_url` (final URL after redirects), `fetch_method`, `received_filename` (from Content-Disposition or the URL), `informed_mime_type` (the Content-Type header), `declared_size_bytes` (Content-Length), `raw_item_id`, `source_id`, `collection_job_id`. `detected_mime_type` (from the file's first bytes) goes on `document_copies`.

`document_id` and `document_copy_links` stay empty in this step. The collector does not decide which legal document a file belongs to (see Q2).

## 3. The 50 MB limit: memory, streaming, time

Real constraint: `unpdf` (pdf.js) needs the **whole PDF in memory** to parse it, so text extraction cannot stream. One PDF in flight costs the file itself plus pdf.js working memory (often 1–3× the file size), inside a 128 MB isolate shared with other requests.

Strategy:
1. **Before downloading:** if Content-Length is over 52428800, do not read the body. Record `not_stored_size_limit` and leave quality `unknown`. The collection then continues exactly as today, falling back to Parallel for text.
2. **Capped read:** read the body chunk by chunk into a pre-allocated buffer and stop at 52428800 + 1 bytes. This covers a missing or false Content-Length. Over the cap → `not_stored_size_limit`.
3. **Hash:** SHA-256 over the buffer with WebCrypto (`crypto.subtle.digest`), which needs no new dependency.
4. **Verification download:** stream the stored object back and hash it incrementally, so a second 50 MB copy is never held in memory. WebCrypto has no incremental hashing and Workers block runtime-compiled WebAssembly (which rules out `hash-wasm`), so this uses `@noble/hashes` (pure JS).
5. **Order inside one target:** fetch → hash → store original (section 4) → **release nothing yet** → extraction. To limit peak memory, files above a configurable threshold `ORIGINALS_INLINE_EXTRACT_MAX_BYTES` (initial value decided from the measurements) are stored but **not** parsed with `unpdf` in the same request. Their text comes from the existing Parallel fallback, and the extraction is recorded as `parallel_extract` (Q3).
6. **Concurrency:** targets are already processed one at a time per job. No parallel uploads are added.

Measurements, required before the flag can be turned on (dev server runs on Node, so they must happen on the published Worker, in test mode):
- Controlled PDFs of about 1, 10, 25, 40 and 50 MB, plus 52428801 bytes.
- For each: success or a "memory limit exceeded" / CPU error in server logs, wall time, CPU time, upload time, verification time.
- Two jobs at once using the 25 MB file.
- Result: the real maximum safe size for inline extraction, and confirmation that store + verify works at 50 MB.

If 50 MB **storage** itself (without extraction) fails in the Worker, I stop and present the numbers and options (a lower store limit, or storing the largest files only through a manual path) **before** changing any limit. The database CHECK of 52428800 is not touched.

## 4. Persistence sequence (unchanged contract)

```text
hash → create or reuse document_copies row (pending) → upload (upsert:false)
     → verify (size + SHA-256 of the stored object) → stored
```

- `insert ... on conflict (file_sha256) do nothing` creates the `pending` row, or returns the existing row.
- If the existing row is `stored`: no upload. The sighting says `deduplicated`. This trusts the earlier verification and does not re-download (see Q4).
- Upload returns "already exists": the object is accepted **only** if the size and hash of the stored object match. Then the row becomes `stored`.
- Size/hash mismatch: the row becomes `conflict`. Nothing is overwritten or deleted. The collection continues with `original_storage.status = failed` and `error_class = storage_conflict`.
- `stored` is set with `stored_at = now()`, and only after verification passes.

Writes run on the server with the service_role client, loaded inside the handler. The key never reaches the browser.

## 5. Concurrency and recovery for `pending` rows (no schema change)

`document_copies.updated_at` is refreshed by the existing `set_updated_at` trigger, so it can serve as the lease.

- **Claim:** whoever creates the row owns it. Someone who finds a `pending` row can take it over only with
  `update ... set storage_status='pending' where file_sha256=$1 and storage_status='pending' and updated_at < now() - interval '5 minutes' returning id`. Exactly one caller wins, and the update renews `updated_at`.
- **Second run while the lease is fresh:** it waits a bounded time, polling the row every 2 s for at most 30 s. If the row becomes `stored` → `deduplicated`. Still `pending` → `original_storage.status = failed`, `error_class = pending_in_progress`. The raw item is written normally. There is no infinite wait.
- **Abandoned run** (crash between upload and verify): the next run that sees a stale `pending` takes it over, runs the "already exists" branch, verifies and finishes. A manual reconcile action (server function, staff only, no deletion) does the same for a given copy id.
- **Object missing for a `stored` row** (found when needed): the row is marked `missing`. Nothing is deleted. The next collection of the same bytes uploads it again, verifies, and sets `stored`.

## 6. Partial failures

- Original stored, extraction fails (no text layer, parser error): the copy, the sighting and `original_storage: stored` are kept. The failure is recorded on its own: the raw item becomes the blocked record as today, and the sighting is linked to that blocked row. `recordBlockedItem` gains an optional return of the row id; its behavior and the alert stay the same. No `document_extractions` row is written for a failed extraction.
- Extraction succeeds but looks truncated (fewer pages than the PDF reports, or a sudden cut): the extraction is recorded with `truncation_status = 'truncated'` or `'unknown'`, never `complete`.
- Extracted text over 1 MB: stored as `text/<hash>` in the same bucket through the same verify flow, with `text_storage_path` set (the existing CHECK allows this).
- Sighting/extraction insert fails after the copy was stored: the copy stays `stored`, `original_storage` records `status: stored` plus `error_class: sighting_failed`, and the job summary counts it.

## 7. Compatibility: storage fails, collection continues

- All storage work is wrapped so that **no** storage or database error inside it can change what the collector returns today. `raw_items` content, content_hash, the fallback chain, `recordBlockedItem` and alerts stay identical.
- On any failure, `original_storage.status = "failed"` with a short error class only (e.g. `upload_error`, `verify_mismatch`, `db_error`, `timeout`). No provider body and no secrets.
- The job's `run_params` summary gains counts: `originals_stored`, `originals_deduplicated`, `originals_failed`, `originals_skipped`.
- Flag off: no storage calls at all, and `original_storage.status = "disabled"`.

## 8. Activation and rollback

Server variable `ORIGINALS_STORAGE_MODE`, read inside handlers:
- unset or `off` (the default): nothing changes.
- `test`: storage runs only for manual runs given an explicit `store_originals: true` input. The scheduler never stores in this mode.
- `on`: manual runs and the scheduler.

Roll-out:
1. Deploy with the flag unset; confirm nothing changed.
2. Set `test`; run controlled files (section 9) on the published app.
3. Run 1–2 real sources manually.
4. Set `on` only after the owner approves.

Rollback = set it back to `off`. Files, copies, sightings and extractions are kept, and nothing is deleted.

## 9. Tests

Unit tests (Vitest, mocked storage/db):
1. Pending → upload → verify → stored, in order. Verification failure → `conflict`, no overwrite.
2. Object already exists with the same bytes → accepted after verify. With different bytes → `conflict`.
3. A fresh pending row held by another run → bounded wait, then `pending_in_progress`. A stale lease → takeover.
4. Size limit: Content-Length over the limit → body not read. No Content-Length but the stream exceeds the cap → aborted at 52428801 bytes, `not_stored_size_limit`.
5. Parallel-only and Webshare paths → no copy, no sighting, `not_available_text_only`.
6. Upload error / db error → the raw item is identical to a flag-off run except for `original_storage`.
7. Extraction failure after store → copy kept, blocked record linked, alert behavior unchanged.
8. Truncated text → `truncation_status` is never `complete`.
9. Flag off → zero storage calls.

Controlled real-environment tests (published app, `test` mode, files under a fixed test source):
10. The same PDF from two different URLs/sources → one copy, two sightings (`stored` + `deduplicated`).
11. Size series (section 3) with measurements recorded.
12. Interruption: a forced stop after upload, before verify (test-only switch) → stale `pending` → the next run recovers it to `stored`.
13. A forced upload failure → collection still succeeds, `original_storage.failed`.
14. Cleanup of test data uses only the exact-path procedure from step 2 for the test-prefixed objects, plus a listed-id removal of the matching test rows. This needs separate owner approval because the tables are append-only by design; see Q5.

## 10. Files that change

- New `src/lib/document-storage.server.ts`: capped read, hashing, pending/claim/upload/verify/stored, recovery, MIME sniffing.
- New `src/lib/document-storage.server.test.ts`.
- `src/lib/pdf-collect.server.ts`: call the storage step on the direct-fetch success path, record sighting/extraction, add `original_storage` to `raw_payload`.
- `src/lib/blocked-items.server.ts`: optionally return the new row id (no behavior change).
- `src/lib/collection.functions.ts`: accept `store_originals` (test mode only).
- `src/lib/gibraltar-collect.server.ts`, `fek-collect.server.ts`, `malta-collect.server.ts`: the same call on their direct-PDF paths. Proposed as **step 3b**, after `pdf-collect` passes the real-environment tests.
- `AGENTS.md`: one rule ("an original file is only bytes received from the source; text-only paths never create copies").
- `scheduler.server.ts`: no code change (it calls `runPdfCollection`; the flag decides).

New dependency: `@noble/hashes` (pure-JS incremental SHA-256 for streamed verification; works in Workers).

**Schema changes: NONE.** Everything fits the existing `document_copies` / `document_copy_sightings` / `document_extractions` columns and CHECKs.

## 11. Acceptance criteria

- With the flag off, the output of an identical collection run is byte-for-byte the same as today, apart from `original_storage: disabled`.
- With `test`, every direct-fetch PDF/HTML ends with a `stored` or `deduplicated` copy whose stored object matches size and hash. Text-only paths create no copy.
- No storage failure changes ingested/duplicate/failed counts or the blocked/alert behavior.
- The 50 MB store + verify works on the published Worker, or the measured numbers are presented before any limit change.
- No automatic deletion anywhere in the code.

## 12. Owner questions

1. Step order: `pdf-collect` first (3a), then Gibraltar / ΦΕΚ / Malta (3b)?
2. Leave `document_id` / `document_copy_links` empty in this step, linking copies to legal documents later by hand?
3. App-shell case: record the Parallel text as an extraction attached to the stored shell copy (flagged "not derived from stored bytes"), or record no extraction there?
4. Dedup against a `stored` copy: trust the earlier verification (proposed), or re-verify on every sighting (more traffic and time)?
5. Clean-up of controlled test rows in the append-only tables: approve a one-off, listed-id removal, or keep the test rows marked under the test source?
