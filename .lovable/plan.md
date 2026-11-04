# Single authorization request — one real test of original-PDF storage (3a)

**This card is a runbook, NOT a task. Approving the card does not authorize anything. Nothing runs until the owner gives a separate, explicit "yes".**

Labels: [V] verified now, [E] reported earlier, [N] not tested.

## 0. Publish status and pending changes
- Live site https://oryxscrape.lovable.app answers 200 [V]. I can't see the publish panel, so which revision is live is unconfirmed [N].
- Latest commit: `a9e538b` [V]. Commits after `fa73d6f`: `14d2edb`, `a9e538b`; both change only `.lovable/plan.md` [V, git diff]. So the "changes since the published version" notice is plan-only, assuming `fa73d6f` is live [N].
- Before publishing with `test`: re-confirm the exact commit and that every change since the live version is plan/docs only. If any code differs, stop.

## 1. File and test source
- URL: `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf` (public, tiny, no personal data; about 13 KB [E]).
- Owner's single preparatory download on their own machine:
  `curl -sSL -w '%{http_code}\n' -o d.pdf <URL>; head -c 4 d.pdf; wc -c d.pdf; shasum -a 256 d.pdf`
  Use size and hash as reference only if HTTP is 200 and the first 4 bytes are `%PDF`. If not, or size > 65,536 bytes: stop.
- `sources` row (required columns [E]):

| column | value |
|---|---|
| id | `3a0e5ca1-0000-4000-8000-0000000003a1` (identifier) |
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

- Not picked by the scheduler [E]: needs `schedule_enabled=true`; cron calls fixed country routes; scheduled runs never ask to store originals.

## 2. Settings
- `ORIGINALS_STORAGE_MODE=test`
- `ORIGINALS_INLINE_EXTRACT_MAX_BYTES=65536` (about 5x the file, so it's parsed locally).

## 3. How the setting reaches the published app
- Runtime server value: read as `process.env["ORIGINALS_STORAGE_MODE"]` inside server handlers (`collection.functions.ts` lines 42, 190) [V]. Not a `VITE_` variable; the browser gets only `{ active }` [E].
- Lovable docs: the published app picks up a changed secret at the next publish [E, docs]. Not observed in this project [N].
- Check inside the operation: after setting and publishing, the checkbox must appear for staff. If not, stop.

## 4. Parallel — the single owner decision
- When it can fire [V, `pdf-collect.server.ts` 255–284]: if the direct read fails, times out or exceeds 50 MB, or the file is over the inline cap, the run calls the Parallel fallback. Webshare is not used (no proxy on the source) [E].
- At most 1 call, no automatic retry. Price per call: **not determined** [N].
- **Decision: accept, or not, ONE Parallel call at an undetermined price.** If not accepted, the test does not run, because the current path can trigger it. The code will not be silently changed to block it.
- If the call happens: do not repeat the run. Record that "original + local extraction" was NOT demonstrated.

## 5. Expected results (conditional, not promised)
Success path [N]:
- 1 source, 1 job `succeeded`, 1 raw_item.
- 1 `document_copies`: `storage_status='stored'`, bucket `document-originals`, `storage_path='sha256/<2 hex>/<hex>'`.
- 1 Storage object at that path.
- 1 `document_copy_sightings` linked to copy, raw_item, source and job.
- 1 `document_extractions` linked to the copy: `extractor_tool='unpdf'`, `extractor_version='unpdf@1.8.1'` [V, lines 111, 536].

Fallback path (after the PDF was already read) [N]:
- If the original was stored first, the copy, Storage object and sighting stay. Recorded as `original_storage` with `inline_extract: "skipped_cap"` only for cap or size reasons [E].
- **No extraction is created from Parallel text** [V: the extraction row is written only from local unpdf output].
- The raw_item holds Parallel text, with the reason in `attempts`.
- If Parallel also fails: a blocked record and 1 alert email.

Partial failure: possible leftovers include a `pending` copy (lease later expires), a `conflict` copy, or a Storage object with no `stored` row (upload completed after a timeout) [E, mocks only]. All are listed and kept; no destructive cleanup.

Never created: legal documents, versions, approvals, normalized items.

## 6. Checks
- Before: counts of sources, jobs, raw_items, copies, sightings, extractions and Storage objects in `document-originals`; state of the 2 old running jobs.
- After: list every new row and object; all tied to the test source/job; earlier rows unchanged; copy hash and size match the owner's reference; links hold.
- The owner downloads the stored file via a 300 s signed link and compares size and SHA-256. This is verification, not a second collection.

## 7. Stop criteria and close
- Stop on: memory error, timeout, hash/size mismatch, conflict, unexpected writes, **a second Parallel call**, activity outside the manual run, or checkbox missing after publish.
- Close after the single attempt, success or failure:
  1. Delete both secrets.
  2. Republish.
  3. Reload Collection jobs and confirm the checkbox is gone (indicator off). If it still appears, stop and investigate; start no other collection.
- Keep every ID, path and file. Delete nothing; no automatic repeat. The 3a pilot then closes with its limitations.

## 8. Alerts
- Failure alerts go to ops@auramaris.app from OryxScrape's own Resend [E]. Unchanged.

## What the owner's separate "yes" would cover
1. Create the test source.
2. Confirm commit and plan-only changes, set both secrets, publish.
3. One manual run with the checkbox ticked.
4. The Parallel decision from section 4.
5. Only the results in section 5.
6. The checks in section 6.
7. The close in section 7.
