# Single authorization request — one real test of original-PDF storage (3a)

Planning only. Nothing has been run. [V] verified now, [E] reported earlier, [N] not tested.

## 0. Status of the publish of fa73d6f
- The live site https://oryxscrape.lovable.app answers 200 right now [V].
- I can't see the publish panel or which revision is live, so I can't confirm the publish finished or that it serves fa73d6f [N]. Please check the version marked live in History. I won't retry it.
- Latest revision in the project: `fa73d6f` (plan file only; code same as the checkbox revision) [V].

## 1. File and test source
- URL: `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf`. Public, tiny, stable, no personal data. Size about 13 KB [E, not re-checked].
- Size and SHA-256: the owner downloads it once on their own machine: `curl -sSL -o d.pdf <URL>; wc -c d.pdf; shasum -a 256 d.pdf`. I make no download.
- `sources` row (required columns from the schema [E]):

| column | value |
|---|---|
| id | `3a0e5ca1-0000-4000-8000-0000000003a1` (the identifier) |
| name | `TEST 3a originals — do not schedule` |
| notes | `TEST:phase1b-3a` |
| domain | `www.w3.org` |
| start_url | the URL above |
| collection_method | `http` |
| is_active / schedule_enabled | `true` / `false` |
| tos_status / robots_status | `unknown` / `unknown` |
| is_official_domain / is_primary_document | `false` / `false` |
| traceability_level | `direct_url` |
| institution_class | `unknown` |
| crawler_type | `cheerio` (unused for `http`) |
| proxy_config, apify_actor_id, include_url_globs | `NULL` |

- Not picked by the scheduler [E]: requires `schedule_enabled=true`; cron jobs call fixed country routes; scheduled runs never ask to store originals.

## 2. Settings
- `ORIGINALS_STORAGE_MODE=test`
- `ORIGINALS_INLINE_EXTRACT_MAX_BYTES=65536` (64 KiB: about 5x the file, so it is parsed locally; any PDF over 64 KiB would skip local parsing). If the owner's measured size is over 65536, stop and re-propose.

## 3. How the setting reaches the published app
- Mechanism in this code: a server-side runtime value. It's read as `process.env["ORIGINALS_STORAGE_MODE"]` inside server function handlers (`collection.functions.ts` lines 42 and 190) [V]. It's not a `VITE_` variable and isn't in the browser bundle [V]. The browser receives only `{ active }` [E].
- Lovable docs: the published app picks up a new or changed secret only at the next publish [E, docs]. Not observed in this project [N].
- Verification inside the operation (no advance change): after setting secrets and publishing, the checkbox must appear on Collection jobs for staff. If it does not appear, stop.
- Return to off: delete both secrets, publish again, confirm the checkbox is gone.

## 4. Parallel fallback
- Only if local handling fails. At most 1 call, no automatic retry; the source has no proxy, so no Webshare [E].
- Price per call: could not be determined [N]. **The owner must explicitly accept one call at an undetermined price.**
- If it happens: record that "original PDF + local extraction" was NOT demonstrated, even if text is collected.

## 5. Expected writes
Success path [N]:
- 1 source (above), 1 job `succeeded`, 1 raw_item.
- 1 `document_copies`: `storage_status='stored'`, `storage_bucket='document-originals'`, `storage_path='sha256/<2 hex>/<hex>'`.
- 1 Storage object at that path.
- 1 `document_copy_sightings` linked to copy, raw_item, source and job.
- 1 `document_extractions` linked to the copy, with `extractor_tool='unpdf'` and `extractor_version='unpdf@1.8.1'` [V, `pdf-collect.server.ts` lines 111 and 536].

Fallback path [N]: source, job, raw_item from Parallel text; no copy, sighting, extraction or Storage object. If Parallel also fails: 1 blocked record and 1 alert email.

Never created: legal documents, versions, approvals, normalized items.

## 6. Checks
- Before: counts of sources, jobs, raw_items, document_copies, sightings, extractions, Storage objects in `document-originals`; state of the 2 old running jobs.
- After: only the rows above are new, all tied to the test source/job. Earlier rows are unchanged. Copy hash and size match the owner's values; links hold.
- The owner downloads the stored file via a 300 s signed link and compares size and SHA-256. That's verification, not a second collection.

## 7. Stop criteria and return to off
- Stop on: memory error, timeout, hash or size mismatch, conflict, unexpected writes, an unplanned fallback, any activity outside the manual run, or checkbox missing after publish.
- After the single attempt, success or failure: delete both secrets, publish, confirm off. Keep every ID, path and file. Delete nothing, no automatic repeat. Then the 3a pilot closes with its limitations.

## 8. Alerts
- Failure alerts go to ops@auramaris.app from OryxScrape's own Resend [E]. Unchanged.

## Owner approves in one go
1. Create the test source above.
2. Set both secrets, then publish.
3. One manual run with the checkbox ticked.
4. At most 1 Parallel call at an undetermined price.
5. Only the writes in section 5.
6. The checks in section 6.
7. Delete secrets and publish to return to off.
