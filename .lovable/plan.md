# Manual Upload Queue

A staff screen listing documents our collectors could not download. Staff download each file in their own browser, upload it here, and it goes into the normal pipeline. Review stays human: nothing is approved or published automatically.

## Answers to your questions

1. **Does `item_status` include `'blocked'`?** No. Current values are `collected, failed, pending, superseded`. One migration adds it: `ALTER TYPE public.item_status_type ADD VALUE 'blocked';`. `'failed'` exists but has never meant "needs a manual upload", so the queue uses only `'blocked'`.
2. **Is `unpdf` available?** Yes, `unpdf ^1.8.1` is already installed. The Gibraltar and PDF collectors use it on the server. It also runs in the browser, so no new package is needed for PDFs.
3. **How is normalization triggered?** Collectors do not trigger it. Normalization runs as a separate staff step: `runNormalizeJob` (per job, in `normalize.server.ts`, called from `collection.functions.ts`), which calls `normalizeWithLogoriOn` and inserts `normalized_items`. The review and legacy screens also call `normalizeWithLogoriOn` directly for single items. The upload flow will call `normalizeWithLogoriOn` for the one new raw item and use the same insert fields as `runNormalizeJob`. The new item starts as `unreviewed` / `internal_only`.
4. **Is there a storage bucket?** No bucket exists. The MVP handles files in the browser only. Text is extracted in the browser and only the text goes to the server. The original file is not stored. The trade-off: no file copy is kept for audit. A private bucket can be added later.
5. **Where does it go in the sidebar?** Right after "Collection jobs" in the operations group, labeled "Manual queue". It will live at `/admin/manual-queue`, next to the existing `/admin/legacy-audit` screen.

## Corrections to the spec (these follow the project's rules)

- **`raw_items` is immutable.** The project's rules say raw items are never changed, and the database only allows inserting and reading them. So the upload does **not** update the blocked record. It **inserts a new raw item** with `supersedes_raw_item_id` pointing to the blocked record. The queue hides blocked records that already have a replacement, so the full history stays in place.
- The field names differ from the spec. Here is how they map:
  - `payload` → `raw_payload`
  - `payload_integrity_type` → `payload_integrity`
  - `jurisdiction_hint` is not a column on `raw_items`. It will be stored as `raw_payload.jurisdiction_hint` on blocked records and shown from there.
- The new raw item uses `raw_payload = { text, plain_text, jurisdiction_hint, original_filename, upload_mime, blocked_error }`, plus `collection_method = 'manual'`, `payload_integrity = 'verbatim'`, `item_status = 'collected'`, `collector_version = 'manual-upload@1.0.0'` and `content_hash = sha256(text)`. The source's facts (official domain, traceability, and so on) are copied from `sources`.
- The Sources screen is at `/sources`, not `/admin/sources`. The "Add to queue" button goes there.

## What gets built

1. **Migration:** add the `'blocked'` value to `item_status_type`. No other schema changes are needed; existing staff insert and read permissions already cover this.
2. **Server functions** in `src/lib/manual-queue.functions.ts`, staff-only through the existing auth middleware and `is_staff` check:
   - `listBlockedItems`: blocked raw items with no superseding row, joined to the source name, newest first.
   - `addBlockedItem({ sourceId, url, jurisdiction, note })`: inserts a blocked raw item with `raw_payload = { error: 'manual_queue', attempted_at, jurisdiction_hint }`. The hash comes from url + timestamp to avoid the unique index.
   - `submitManualUpload({ blockedId, text, filename, mime })`: inserts the replacement raw item, then normalizes it with LogoriOn if no normalized item exists yet. If the text duplicates an existing document, it reports "already in pipeline" instead of failing. If LogoriOn fails, the raw item is kept and a warning comes back, so normalization can be retried from Jobs.
3. **Helper** `src/lib/blocked-items.server.ts`: `recordBlockedItem(supabase, { source, url, error, jurisdiction })`, shared by collectors.
4. **Collector hook (limited to the MVP):** wire `recordBlockedItem` into the generic direct-download collector (`pdf-collect.server.ts`) for 403, 401, SSL, timeout and empty-extraction failures. Other collectors can adopt the helper later without further design work.
5. **Screen** `src/routes/_authenticated/admin.manual-queue.tsx`:
   - Columns: Source, URL (opens in a new tab), Jurisdiction, Collected at, Method, Error, and an "Upload file" button. Styling matches the existing dark glass design.
   - The upload dialog shows the link and the instruction "Open this link in your browser, download the file, then upload it here."
   - It accepts PDF, HTML, TXT and DOCX:
     - PDF: text extracted in the browser with `unpdf`.
     - HTML: tags stripped.
     - TXT: read as plain text.
     - DOCX: shows "not supported yet — save as PDF" in the MVP.
   - It previews the first 500 characters and the total length, and blocks files with empty text.
   - "Insert into pipeline" runs the upload, then shows a success message and refreshes the list.
6. **Sources screen:** an "Add to queue" button per source that opens a small form (URL, jurisdiction, note).
7. **Sidebar:** add a "Manual queue" entry.
8. Update `roadmap.md` and `_CONVENCAO.md` to add the `blocked` status and the supersede rule.

## Out of scope

Keeping the original file in storage, a DOCX parser, and blocked-item hooks in every country collector.
