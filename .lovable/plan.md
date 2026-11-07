# Plan — slice (a): link / create / unlink a source on an approved candidate (no collection)

Slices (b) and (c) from 0625247 are not re-planned here. Labels: [V] verified this turn, [E] reported earlier. Nothing implemented. No migration.

## Facts check
Owner's facts are correct [V]: defaults `collection_method='apify'`, `is_active=true`, `schedule_enabled=false`, `tos_status`/`robots_status='unknown'`, `traceability_level='untraceable'`, `institution_class='unknown'`, `is_official_domain`/`is_primary_document=false`, UNIQUE(domain, start_url). Additions: `crawler_type` default `'cheerio'` (unused by `http`); CHECK values `tos_status` ∈ unknown/allowed/restricted/prohibited, `robots_status` ∈ unknown/allowed/disallowed/partial.

## Cut
In: link existing compatible source, create new `http` source and link, unlink, withdraw-approval rule.
Out: starting collection, raw item choice, `collection_job_id`, history, schema, originals (off), stuck jobs, changes to `createSource`/`updateSource`.

## Compatible source (server-checked)
`collection_method='http'`, `is_active`, `schedule_enabled=false`, `start_url` not containing `transport.gov.mt`. Picker lists only these; never filtered or chosen by domain alone. Confirm step shows start URL, method, schedule, active and the four classification fields plus tos/robots, next to the candidate's confirmed URL (a mismatch is shown, not blocked — matching the URL is checked in slice (b)).

## Actions and transitions
```text
approved_for_collection, open, needs_review=false, source_id NULL
  -- link_source(sourceId) -->            source_id = sourceId
  -- create_source_and_link(form) -->     new http source; then source_id = new id
source_id set, collection_job_id NULL, raw_item_id NULL, retrieval_state 'none'
  -- unlink_source -->                    source_id NULL (source row kept)
```
- Create: server derives `domain` from the confirmed URL (`new URL().hostname`, exact; no rewriting of the URL). If UNIQUE(domain,start_url) hits (23505) → no insert; return the existing source with its config and offer "link this source" only if compatible.
- Create then link fails (conflict/zero rows): return `{ createdSourceId }`; UI shows "Source created but not linked" with a "Link this source" button. Never re-creates (the unique key would also block it).
- Unlink blocked if `collection_job_id` or `raw_item_id` is set, or `retrieval_state <> 'none'`.
- Withdraw approval (existing action): block while `source_id` is set — the human unlinks first. Keeps the rule "links are never cleared silently". Requires a one-line precondition added to `withdrawCore` and its UI.

## Exact payloads
- Candidate link / unlink: `source_id`, `reviewed_by` (context.userId), `reviewed_at` (server clock).
- Candidate guard: `id`, exact original `updated_at`, `stage='approved_for_collection'`, `outcome='open'`, `needs_review=false`, `source_id IS NULL` (link) or `= expected id` (unlink); unlink also `collection_job_id IS NULL`, `raw_item_id IS NULL`, `retrieval_state='none'`. Zero rows = conflict, no retry.
- New source insert (allowlist): `name`, `domain`, `start_url`, `collection_method='http'`, `is_active=true`, `schedule_enabled=false`, `is_official_domain`, `is_primary_document`, `traceability_level`, `institution_class`, `tos_status`, `robots_status`, `notes` (optional). All classification/tos/robots fields required in the input (no fallback to DB defaults); form pre-selects nothing and shows each DB default as a hint.
- Never written: any existing source, `collection_job_id`, `raw_item_id`, `retrieval_state`, `stage`, confirmed_*, confidence, outcome*, needs_review, review_note, lead fields, keys.
- All through the user's own client (RLS: staff insert sources, staff update candidates); staff check before any write; no service role.

## Files
- `src/lib/discovery-source-link.ts` (new): compatibility check, input validation, guards, payload builders.
- `src/lib/discovery.functions.ts`: `listCompatibleSources`, `linkCandidateSource`, `createSourceForCandidate`, `unlinkCandidateSource`; detail select adds `source_id`, `collection_job_id`, `raw_item_id`, `retrieval_state`.
- `src/lib/discovery-approval.ts`: withdraw refused when `source_id` set (state read adds `source_id`).
- `src/components/discovery-source-link.tsx` (new) + mount in the candidate panel. Copy: "Linking a source does not start collection."
- `src/lib/discovery-source-link.test.ts` (new); one added case in `discovery-approval.test.ts`.

## Mock tests
- Link refused unless approved/open/no flag/source NULL; refused for apify, api, inactive, scheduled, transport.gov.mt sources.
- Create sends `collection_method='http'` and `schedule_enabled=false` explicitly; missing classification field refused; domain derived from URL; start_url byte-identical.
- Duplicate (domain,start_url) → no insert, existing source returned.
- Created-but-not-linked → returns created id; recovery links it without a second insert.
- Stale updated_at/stage/outcome/source_id → conflict, no write, single attempt.
- Unlink blocked by job, raw item or retrieval_state; source never deleted or updated.
- Withdraw blocked while source linked.
- Patch keys exact; reviewer from server; non-staff refused before write; no call to startCollectionJob, createSource/updateSource or any external service.

## Real DB gaps (not proven by mocks)
RLS on sources insert and candidate update; actual 23505 code/shape; FK on `source_id`; real concurrency between tabs.

## Risks
- Create + link are two writes (no transaction): an unlinked source can remain; handled by recovery, not deleted.
- Classification chosen by the human is snapshotted onto future raw items; wrong values persist in those rows.
- Rules are app-only.

## Blockers
None for building. For the later acceptance test: Cap. 283 candidate `aeb72796-3e7c-487d-8aac-52b2963f3d4b` is `lead/open` [V]; it needs source verification and explicit approval first.
