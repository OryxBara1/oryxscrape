# Phase 1B — Document copies, extraction and quality (plan only)

Status: Phase 1A accepted and closed. Nothing in this plan is applied until the owner approves 1B explicitly. Out of scope: Phase 1C, UI, LDH calls, scheduling, the 4 old advisor warnings. OryxScrape stays independent; no connection to any other product.

## 0. Closing note for Phase 1A (to be written to roadmap.md on approval)

- Authorization was tested by simulating database role and identity, not real browser logins. Real-login test deferred to the UI phase.
- Absence of DELETE/TRUNCATE verified for anon, authenticated and service_role only, not for owner/admin roles.
- Dedup tests proved constraints and uniqueness of supplied keys. Key construction, URL canonicalization and conflict handling in app code remain untested until that code exists.
- Exposed schemas: NOT verified, not changed. No claim that the new tables are outside the Data API; schema exposure, grants and RLS are separate layers.
- Pending, separate: conservative URL canonicalization (before Phase 2); the 4 old advisor warnings (own round).

## 1. What already exists and is reused

| Existing | Reused for | Why no new structure |
|---|---|---|
| `raw_items` (immutable, INSERT/SELECT only, `content_hash` = SHA-256 hex of text, `collection_method`, `collector_version`, `payload_integrity`, `supersedes_raw_item_id`) | The collection event itself | Stays untouched. 1B links to it, never writes to it. |
| `sources`, `collection_jobs` | Where/when a copy was fetched | Already carry origin and job identity. |
| `discovery_candidates` (1A) | Origin of a lead that produced a document | Linked by FK, no change. |
| `staff_members` + `public.is_staff()` | All RLS checks | Same pattern as every existing table. |
| `public.set_updated_at()` | Mutable-row timestamps | Already used project-wide. |
| `audit_events` | Not reused for assessments | Its enum `audit_check_type` and shape are for system checks; quality judgments need their own typed, append-only records. |
| Fallback chain (direct → Parallel → Webshare → blocked) | Obtaining the file | Unchanged; 1B only stores what it returns. |

Note: there are no storage buckets today and no code writes files to storage. `exchange_handoffs.artifact_sha256` exists but belongs to the exchange flow and is not reused.

## 2. Four concepts, four tables (all new, each justified)

```text
legal_documents (1)                 the abstract document we believe exists
   └─ document_copies (n)           one obtained file, identified by file hash
         ├─ document_copy_sightings (n)   each time/source/raw_item this same file was seen
         ├─ document_extractions (n)      one text extraction run, tool + version + text hash
         │     └─ document_assessments (n) quality / origin / approval records, append-only
         └─ document_assessments (n)      (copy-level assessments use the same table)
legal_document_versions (n)         documentary version of the norm — ONLY created by a human
```

1. `legal_documents` — the document as an entity (title, identifier, country_code, issuing_authority, language, doc_type, optional `discovery_candidate_id`). Needed because one document can have many copies from many sources; neither `raw_items` nor `normalized_items` model that.
2. `document_copies` — one row per distinct file content. Unique on `(file_sha256)`. Holds storage path, size, MIME, byte-integrity status. Needed to keep the binary separate from the text.
3. `document_copy_sightings` — append-only link table: copy ↔ `raw_items.id` / `source_id` / `collection_job_id` / fetched URL / fetch method / fetched_at. This is the required link to `raw_items` without changing raw_items content. Also solves "same copy from another source".
4. `document_extractions` — append-only: copy_id, `extractor_tool`, `extractor_version`, `text_sha256`, `char_count`, `page_count_detected`, `truncation_status`, extracted text (or storage path for long text). Needed so file hash and text hash never mix.
5. `document_assessments` — append-only judgment records (see section 4).
6. `legal_document_versions` — documentary version (e.g. consolidated text as of a date). Created only by a staff action, referencing the copy/extraction that supports it. Needed to enforce rule 9.

Six tables is the minimum that keeps the 10 rules separable; merging any two would mix a concept the brief asks to keep separate.

## 3. Hashes and identity

- Format: lowercase hex SHA-256, stored with prefix: `sha256:<64 hex>`. DB CHECK `^sha256:[0-9a-f]{64}$`. Same algorithm already used by `content_hash` (Web Crypto `crypto.subtle.digest`, available on Workers).
- `document_copies.file_sha256` = hash of exact bytes received. Unique → identical content is never stored twice.
- `document_extractions.text_sha256` = hash of the extracted text after a documented normalization (UTF-8, `\r\n`→`\n`, trim trailing whitespace). Normalization rule is versioned with the extractor version.
- Rule 9: a different `file_sha256` or `text_sha256` creates a new copy/extraction only. It never creates or changes a `legal_document_versions` row. The DB enforces this structurally: versions have no trigger or FK path from copies; insertion requires staff and an explicit `created_by`.

## 4. Assessments: technical quality vs origin vs approval

`document_assessments` columns (draft): `target_kind` ('copy' | 'extraction'), `target_id`, `dimension`, `value`, `basis` ('automatic' | 'human'), `tool` + `tool_version` (when automatic), `assessed_by` (when human, = auth.uid()), `supersedes_assessment_id`, `note`, `created_at`.

- `dimension` is one of three separate axes, never combined:
  - `technical_quality` — values `complete`, `truncated`, `unreadable`, `partial_ocr`.
  - `source_origin` — values `official_primary`, `official_secondary`, `third_party`, `unknown` (classification of where the copy came from, independent of quality).
  - `approval` — values `approved`, `rejected`, `needs_recheck`. CHECK: `approval` requires `basis = 'human'`. AI/automatic code can never write approval.
- Automatic suggestion vs human confirmation: both are rows; a human row may reference the automatic row it confirms/overrides via `supersedes_assessment_id`. Nothing is updated or deleted; the current state is "latest row per target+dimension".

## 5. Storage

- One new private bucket: `document-originals` (public = false), file size limit 50 MB.
- Path: `sha256/<first 2 hex>/<full 64 hex>.<ext>` — content-addressed, so the same bytes always map to the same path (natural dedup, idempotent retries).
- Policies on `storage.objects` for this bucket:
  - SELECT: `authenticated` with `public.is_staff()` (staff can download through signed URLs).
  - INSERT / UPDATE / DELETE: none for anon/authenticated. Only server code using service role writes, after verifying staff (manual re-check) or inside the collector.
  - No public URLs; downloads via short-lived signed URLs (60 s) issued by a staff-checked server function.
- Long extracted text (> 1 MB) goes to a second private prefix in the same bucket: `text/<text hash>.txt`, same policies.

## 6. Size limits and storage estimate

- Per file: 50 MB hard limit (bucket + app check before upload). Larger: copy recorded as `byte_status = 'too_large'`, no upload, assessment `technical_quality = unreadable` automatic.
- Inline extracted text in DB: up to 1 MB; above → storage.
- Worker memory: files are hashed while held in memory; 50 MB is within Workers limits but close enough that streaming hashing is preferred when feasible.
- Estimate: typical official PDFs 0.3–3 MB. At ~200 new distinct copies/month × ~1.5 MB ≈ 300 MB/month, ~3.6 GB/year before dedup. Text adds < 5 %. Dedup by hash reduces repeat downloads to zero bytes.

## 7. Upload / database consistency (no orphans, no dangling records)

Order for each obtained file:

1. Compute `file_sha256` in memory.
2. If `document_copies` already has that hash → skip upload, only insert a sighting. Done.
3. Upload to the content-addressed path with `upsert: false`. If "already exists" → treat as success (same bytes, same path).
4. Insert `document_copies` row with `byte_status = 'stored'`. Unique conflict on hash → another worker won; insert sighting only.
5. Insert sighting, then extraction.

Failure handling:
- Upload fails → no DB row is written; the existing blocked-record path is used (Manual Upload Queue + alert, as today).
- Upload succeeds, DB insert fails → file stays at its hash path. It is not "lost": the next attempt reuses it (step 3 idempotent). A staff-run reconciliation check lists storage objects without a `document_copies` row and either adopts or deletes them (deletion only by service role, logged in `audit_events`).
- No record points to a missing file: `byte_status = 'stored'` is set only after a confirmed upload; reconciliation also checks the reverse (row with no object → marked `missing`, never deleted).

## 8. Required behaviours

- Download fails: no copy row. Sighting is not created. The existing raw_items blocked record + alert covers it; 1B adds nothing.
- File complete, extraction truncated: copy is stored with `byte_status = 'stored'`; extraction row has `truncation_status = 'truncated'` (detected by page-count vs text, or tool signal); automatic assessment `technical_quality = truncated`. A later re-extraction with another tool/version adds a new extraction row; the old one remains.
- Same copy from another source: same `file_sha256` → no new upload, no new copy; one new sighting row with the new source/raw_item/URL. Origin classification may differ per sighting and is recorded as an assessment.
- Manual re-check (staff): re-downloads; identical hash → new sighting only; different hash → new copy linked to the same `legal_documents` row, previous copy preserved. Never a new version automatically.

## 9. RLS and grants (same pattern as 1A)

- Explicit REVOKE ALL from public, anon, authenticated, service_role on each new table, then explicit GRANTs:
  - authenticated: SELECT on all six; INSERT on `document_assessments` (human rows) and `legal_document_versions`; no UPDATE/DELETE/TRUNCATE.
  - service_role: SELECT, INSERT on all; UPDATE only on `document_copies` (byte_status) and `legal_documents` (metadata); no DELETE/TRUNCATE.
- Policies: staff-only via `public.is_staff()`. Human assessment insert requires `assessed_by = auth.uid()` and `basis = 'human'`.
- Append-only triggers on sightings, extractions, assessments, versions (reuse the style of `discovery_sightings_append_only`).
- Exposed schemas remain unverified; nothing here depends on it.

## 10. Guaranteed by database vs by application code

- Database: hash format, uniqueness of file hash, append-only tables, approval only by humans, staff-only access, no anon access, storage bucket privacy and policies.
- Application code only: correct hash computation, upload-before-insert order, extraction tool detection of truncation, reconciliation job, size check before upload, signed-URL lifetime.

## 11. Verification plan (after approval, before closing 1B)

- Rolled-back SQL test battery like 1A: grants per role, RLS per role (simulated), append-only rejections, approval-by-automatic rejected, hash CHECK, duplicate hash rejected.
- Storage: anon and non-staff cannot read; staff signed URL works; anon cannot upload.
- App-level tests (vitest): hash prefixing, idempotent upload path, "same copy other source" adds only a sighting, truncated extraction recorded.
- Advisors run before/after, new warnings separated from the 4 old ones.
- Stated limits: real-browser login and owner/admin-role checks remain deferred, as in 1A.

## 12. Open questions (only those the owner must decide)

1. Is 50 MB per file acceptable, or should it be lower (e.g. 25 MB)?
2. Should existing collected PDFs (already in `raw_items` as text) be back-filled into copies later, or only new collections going forward? Proposed: forward only in 1B.

## Delivery order on approval

1. One migration: six tables, helpers, triggers, grants, RLS.
2. Create bucket `document-originals` (private, 50 MB) via the storage tool; then one migration with its `storage.objects` policies.
3. Server code for store/link/extract inside the existing collector path (no UI).
4. Tests and the verification report.
