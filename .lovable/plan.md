# Phase 1B — Step 3a: preserve directly received PDFs in `pdf-collect`

Status: PLAN ONLY. Nothing here runs until step 3a is authorized separately.
Out of scope: UI, LDH, scheduling, automatic deletion, the 4 old advisor warnings, any link to another product, exposed-schema settings. Gibraltar / ΦΕΚ / Malta = step 3b.

## 0. Notes to record in roadmap.md (when edits are allowed)

Step 2 closing note:
- Migration `20261103132927`.
- Private bucket `document-originals`, limit 52428800 bytes, MIME unrestricted.
- One SELECT policy, limited to staff and to this bucket.
- The two test objects were removed; the bucket is empty.
- No new advisor warnings (the 4 old ones unchanged).
- NOT executed: a real HTTP login as staff or non-staff, and a direct write attempt as staff. The database simulation and the service_role signed link do not replace those tests. "No write policies" is a configuration we observed, not a functional test we ran.

New task: step 3a planning, scope "PDF only in `pdf-collect`".

## 1. Scope of 3a

- **Format supported: PDF only.** A file counts as PDF when its first bytes are `%PDF`. The Content-Type header alone is not enough.
- **Path:** a direct fetch in `runPdfCollection` (`src/lib/pdf-collect.server.ts`) that succeeds and returns a PDF.
- **Unchanged, with no copy and no extraction:** direct HTML, app-shell HTML then Parallel, Parallel only, Webshare/Apify, blocked items without bytes, and every other collector.
- This narrow scope validates storage, recovery and memory on one path first. It does not mean HTML can never be kept as an original later.

## 2. Behavior by flag mode

Server variable `ORIGINALS_STORAGE_MODE`, read inside the handler.

| Mode | Behavior |
|---|---|
| unset / `off` (default) | Exactly today's code path. No storage calls, **no new fields** in `raw_payload`, no new branch. |
| `test` | Active only for manual runs given an explicit `store_originals: true`. The scheduler never stores. |
| `on` | Manual runs and the scheduler. Turned on only with owner approval. |

Code rule: when the mode is off, the collector does not even call the new module. The integration is one guarded branch, so the off path stays exactly the current code.

## 3. What is stored (flag on, direct PDF)

- **Original:** the bytes as received, at `sha256/<2 hex>/<64 hex>`, uploaded as `application/octet-stream`.
- **`document_copies`:** `file_sha256`, `size_bytes`, `detected_mime_type = application/pdf`, plus status fields.
- **`document_copy_sightings`:** `fetched_url` (final URL after redirects), `fetch_method = http`, `received_filename`, `informed_mime_type`, `declared_size_bytes`, `source_id`, `collection_job_id`, `raw_item_id`, and `byte_outcome` (`stored`, `deduplicated` or `not_stored_size_limit`).
- **`document_extractions`:** only for text that `unpdf` produced **from these bytes**.
  - tool `unpdf` plus its package version.
  - `text_sha256_exact`; `text_sha256_normalized` / `normalization_version` left NULL in 3a.
  - `char_count`, `page_count_detected`, `truncation_status`.
- **Parallel text is never attached to a copy.** If a PDF is kept but its text comes from Parallel (too large to parse in the Worker, or `unpdf` found no text and the current flow continues), there is **no extraction row**. The Parallel text stays in `raw_items` as today.
- `legal_documents` / `document_copy_links` stay empty. The operational links are source, job and raw_item, through the sighting.
- `raw_payload.original_storage` (only when the flag is on): `{ status, copy_id?, sighting_id?, extraction_id?, error_class? }`.
  - Possible `status` values: `stored`, `deduplicated`, `not_stored_size_limit`, `failed`, `pending_in_progress`.
  - The file outcome is kept separate from link/extraction outcomes, using `link_status` and `extraction_status`, each `ok`, `failed` or `not_applicable`. A stored file whose sighting or extraction failed stays `stored`; it is never reported as missing.

## 4. Memory, buffer and time limits

- **Before reading the body:** if Content-Length is over 52428800, the body is not read. Then `byte_outcome = not_stored_size_limit` and the current flow continues.
- **Growing buffer, no 50 MB pre-allocation:** start from Content-Length when it is present and within the cap, otherwise 256 KB. Double as needed up to the cap, then join once. Abort at 52428801 bytes.
- **Hashing:** WebCrypto SHA-256 over the buffer already in memory.
- **Verification:** stream the stored object back and hash it with `@noble/hashes` (incremental, pure JS). It never holds a second full copy. Workers block runtime-compiled WebAssembly, so `hash-wasm` is not used.
- **Inline extraction cap:** `unpdf` runs only on files up to `ORIGINALS_INLINE_EXTRACT_MAX_BYTES`. Proposed start is 15 MB, to be set from measurements. Larger PDFs are stored but not parsed; text comes from the existing flow (Parallel) with no extraction row.
- **Timeouts** (each one is an abort signal; going over gives `failed` with that error class):
  - read body: 60 s
  - upload: 60 s
  - verification download plus hash: 60 s
  - wait on someone else's `pending`: 30 s total, polling every 2 s
  - whole storage step per target: 150 s. After that the step is abandoned and the collection continues.
- **Concurrency reality:** the 128 MB limit applies per isolate, and one isolate can serve several requests at once. "One target at a time per job" does **not** limit system-wide concurrency: two manual runs, or a run plus the scheduler, can land in the same isolate. The inline cap and the measurements (section 9) must assume concurrent runs.

## 5. Persistence sequence and the existing-row read

```text
hash → create-or-read pending row → upload (upsert:false) → verify size + hash → stored (fenced)
```

1. **Create:** `insert` a `pending` row with `on conflict (file_sha256) do nothing`. This **returns no row when one already exists**. In that case the code reads the existing row with a separate `select ... where file_sha256 = $1`.
2. **Existing row:**
   - `stored`: normal dedup. Trust the earlier verification, no upload or download, sighting `deduplicated`.
   - `pending` with a fresh lease: wait (section 6).
   - `pending` and stale: take over.
   - `conflict` or `missing`: do not touch it. `failed` with error class `copy_state_<state>`; staff handle it.
3. **Upload** with `upsert:false`. "Already exists" goes on to verification; it is never accepted by itself.
4. **Verify:** object size equals `size_bytes`, and the streamed SHA-256 equals `file_sha256`.
5. **Finalize:** a fenced update to `stored` with `stored_at = now()`.
   - Size or hash mismatch: fenced update to `conflict`.
   - Nothing is overwritten or deleted.
6. Re-verifying a `stored` copy happens only on an inconsistency or an explicit re-check, never on normal dedup.

## 6. Lease, takeover, and fencing a run that lost ownership

Confirmed in the live database (read-only):
- `document_copies.updated_at` is `timestamptz` (microsecond precision) and is refreshed by the `set_document_copies_updated_at` trigger on every update.
- `document_copies_guard` freezes only the identity fields.
- service_role has SELECT/INSERT/UPDATE on `document_copies`, but only SELECT/INSERT on sightings and extractions.

Design using the existing schema, with `updated_at` as a compare-and-set token:
- **Token:** the `updated_at` returned by the insert or by our last update. Every write to our pending row is
  `update ... where id = $id and storage_status = 'pending' and updated_at = $token returning updated_at`.
  - It returns a row: we still own the row and get a new token.
  - It returns 0 rows: **ownership lost**. The run stops all further writes to that copy: no finalize, no conflict mark. It reports `pending_in_progress` and can still write its own sighting only if the row later reads as `stored`.
- **Renewal:** a no-op fenced update (`set storage_status = 'pending'`) before the upload, before verification, and every 20 s during long transfers.
- **Lease length:** 120 s. Takeover is allowed only when `updated_at < now() - 120 s`, through the same fenced update with the stale token just read. Exactly one taker wins.
- **What a stale run can still do:** its upload uses `upsert:false` on a content-addressed path, so it can never replace bytes. Its finalize fails because of the token. The new owner verifies whatever object exists before finalizing.
- **Leftover risk, stated plainly:** the token relies on `now()` (the transaction start time). Two takeovers committing in the same microsecond could share a token. This is unlikely, but the current schema does not exclude it.
  - **Database dependency (separate, not part of 3a unless approved):** strict fencing needs a `lease_token uuid` column on `document_copies` (or a small claim function), added by its own migration. I am **not** adding it now. Tests 11–12 check the timestamp design; if the owner wants the guarantee, I will present that migration separately.
- **No infinite wait:** every wait is limited to 30 s. Stale rows are recovered by the next run that meets them, or by a manual staff reconcile action (no deletion).

## 7. Linking raw_item, sighting and extraction

Sightings and extractions are append-only, so each is inserted **once, after its references are known**. No row is created just to get an id.

Order inside one target, flag on:
1. Fetch the PDF, then run the storage step (section 5). Result: `copy_id`, or a failure.
2. Run `unpdf` when the file is within the inline cap, exactly as today.
3. Insert the `raw_items` row as today, adding `.select("id")` to get its id. `original_storage` is written into `raw_payload` here, so it is part of the single immutable insert.
4. Insert the sighting with the `raw_item_id` from the matching path:
   - **Success:** the new raw_item id.
   - **Duplicate** (raw insert hits `23505` on `(source_id, content_hash)`): read the existing raw_item id with `select id where source_id = $1 and content_hash = $2`. The sighting points to that existing row. A new sighting is still correct because this is a new observation of the file.
   - **Blocked** (`unpdf` found no text and the chain ended in `recordBlockedItem`): `recordBlockedItem` gets an optional return of the id it inserted. On `duplicate` it reads the existing blocked row by its unique key the same way. Alerts are unchanged.
   - **Size-limit:** sighting with `copy_id NULL`, `byte_outcome = not_stored_size_limit`, linked to whichever raw_item the flow produced.
5. Insert the extraction only when `unpdf` text came from the stored copy.
6. **Already-known limitation:** `original_storage` is written in step 3, before steps 4–5. If step 4 or 5 fails, `raw_payload` cannot be updated afterwards because `raw_items` is append-only. The failure goes into the job's `run_params` summary per target (`link_status` / `extraction_status` plus error class) and the server log. The stored copy stays `stored`. Recording these outcomes in `raw_payload` too would mean putting the sighting first, without a raw_item id; that is not proposed.

Long text over 1 MB: upload to `text/<2 hex>/<64 hex>` (exactly `'text/' || substr(hash,8,2) || '/' || substr(hash,8)`), verify the same way, set `text_storage_path`, leave `text_inline` NULL.

Truncation: `truncation_status = truncated` when pages with text are fewer than the PDF's page count by a defined margin, `unknown` when that can't be judged, and `complete` only when every page produced text.

## 8. When storage fails

Requirement, to be **tested**, not assumed: with the flag on, any error caught inside the storage step leaves the collection result as it would be with the flag off (same raw text, content_hash, counts, fallback chain, blocked/alert behavior), apart from `original_storage` and the job summary counts.

Not covered by that rule, stated honestly: running out of memory or the Worker being killed ends the whole request. The job can stay `running` and later targets are not processed. This is why the inline cap and the measurements exist, and why test mode comes before `on`.

## 9. Tests

**Unit tests (Vitest, storage/database mocked; nothing written anywhere):**
1. Flag off: the collector never calls the module, and `raw_payload` matches today's output exactly (no `original_storage` key).
2. Growing buffer: no Content-Length; a small file allocates little; the stream stops at 52428801 bytes.
3. Content-Length over the limit: body not read, `not_stored_size_limit` sighting with no copy.
4. Sequence pending → upload → verify → stored. Mismatch → `conflict`, no overwrite.
5. "Already exists" with the same bytes → accepted after verify; with different bytes → `conflict`.
6. Insert conflict returns no row → separate read of the existing row; each existing state handled as in section 5.
7. Fresh `pending` → wait up to 30 s, then `pending_in_progress`. Stale → takeover.
8. Lost ownership: the fenced update returns 0 rows → no finalize or conflict write by the stale run.
9. Each timeout (body, upload, verify, wait, total) → `failed`, and the collection continues.
10. Linking: new / duplicate / blocked / size-limit paths give the right `raw_item_id`. A sighting or extraction failure → copy stays `stored`, summary records it.
11. Parallel text after a large or text-less PDF → no extraction row.
12. Long-text path is exactly `text/<2>/<64>`.
13. Truncation classification.
14. HTML, app-shell, Parallel-only and Webshare paths are unchanged with the flag on.

**Controlled real-environment tests (a later round, separate authorization):**
- First confirm the deploy environment the project actually uses (Lovable published app, preview, or something else) and give its exact steps; no URL or publish procedure is assumed.
- Prefer an isolated environment. If the current project is used: a clearly named test source, files under that source only, append-only protections never disabled, no destructive cleanup. List every row id and storage path created in each round. Files pointed to by kept rows are never deleted.
- Cases:
  - the same PDF from two URLs: one copy, two sightings
  - a size series of about 1 / 10 / 15 / 25 / 40 / 50 MB plus 52428801 bytes
  - **two and three concurrent runs** on 25 MB files
  - a forced stop between upload and verify, then recovery
  - a forced upload failure
  - a text-less PDF (blocked path)
  - the duplicate raw_item path
- Record success or memory/CPU errors, wall time and per-step timings.
- If 50 MB **storage** (without parsing) fails, stop and present the numbers and alternatives before any limit changes. The database CHECK stays 52428800.

## 10. Files to change (3a)

- New `src/lib/document-storage.server.ts`: capped growing read, hashing, create-or-read, fenced lease/takeover, upload, streamed verify, finalize, long-text upload, timeouts.
- New `src/lib/document-storage.server.test.ts`.
- `src/lib/pdf-collect.server.ts`: one guarded branch on the direct-PDF success path; `.select("id")` on the raw insert; sighting/extraction inserts; per-target summary.
- `src/lib/blocked-items.server.ts`: optionally return the inserted or existing row id (no behavior change).
- `src/lib/collection.functions.ts`: accept `store_originals` (honored only in `test` mode).
- `AGENTS.md`: one rule — "an original file is only bytes received from the source; text from another engine is never attached to a copy".
- Not changed: `scheduler.server.ts` (the flag decides), other collectors (3b), UI.
- New dependency: `@noble/hashes`.

## 11. Database dependencies (separate)

- **Schema changes: none expected, to be confirmed** before implementation with a read-only re-check of columns, CHECKs, triggers and service_role privileges on `document_copies`, `document_copy_sightings`, `document_extractions`, `raw_items`.
- **Optional, separate approval:** a `lease_token uuid` column (or a claim function) for strict fencing (section 6).
- No Storage policy change: writes use service_role on the server.

## 12. Activation sequence

1. Implement with the default `off`. Unit tests pass, and test 1 proves the off path is unchanged.
2. Deploy. Confirm a normal collection result is unchanged.
3. Confirm the deploy environment; set `test` (owner action, separate authorization).
4. Run the controlled real-environment tests and report ids, paths and measurements.
5. Run 1–2 real sources manually in `test` mode.
6. Switch to `on` only with owner approval.
7. Rollback at any point = `off`. Files and rows are kept, nothing is deleted.

## 13. Acceptance criteria

- With the flag off, the output is identical to today, with no new payload fields (unit-tested and checked after deploy).
- With `test`, every direct PDF ends as `stored` or `deduplicated` with a verified object, or with an explicit `failed` / `not_stored_size_limit` / `pending_in_progress`.
- No path attaches Parallel text to a copy.
- Lost-ownership and timeout cases leave no false `stored`.
- Real-environment numbers are reported, including concurrency, before `on`.
- No automatic deletion anywhere.
