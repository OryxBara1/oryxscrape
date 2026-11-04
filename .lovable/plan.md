# Runbook — one real test of original-file storage (3a), revised

Planning only. Nothing has been run. Labels: [V] = verified in this session, [E] = reported from earlier work, [N] = not tested yet.

## STOP: no signed-in way to run the test exists today

- **(a) How the call would be made:** `startCollectionJob` requires a staff session. The screens never send `storeOriginals` [V]. The agent has no staff session, and this project's backend is user-managed, so I cannot create one [V]. That leaves no authenticated way to send `storeOriginals:true`. I will not ask for passwords or tokens, improvise endpoints, or bypass sign-in.
- **(b) Which environment:** the only one that makes sense is the published app, https://oryxscrape.lovable.app [E].
- **(c) Whether that environment receives the secrets:** secrets are set per project. [N] I haven't checked whether a newly set secret reaches the published app without a new publish.

Smallest options, none implemented (each needs its own authorization):
1. **Staff-only checkbox.** "Store original (test)" on the existing manual run form, shown only in `test` mode. It needs a code change, tests and a publish.
2. **Hidden staff-only button.** It runs the fixed test source with `storeOriginals:true`. It also needs a code change, tests and a publish.
3. **Owner runs it from their own browser.** The owner calls `startCollectionJob` while signed in to the published app (for example a one-off console snippet I provide). No code changes are needed. The session never leaves the owner's browser, but it's more error-prone.

The rest of this runbook applies once one option is chosen and in place.

## Configuration found
- `ORIGINALS_STORAGE_MODE` is absent [V], from the secret names list.
- `ORIGINALS_INLINE_EXTRACT_MAX_BYTES` is absent [V], from the secret names list.
- In the code, absent means off and a cap of 0 [V].
- `PARALLEL_API_KEY` is present, so a Parallel fallback is possible [V].
- I can't see the secret values or what the running published app reads [N].

## Test file and source
- File: `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf`, about 13 KB [N].
- Size and hash: the owner downloads the file once on their own machine and records the size and SHA-256 before the run (`curl -sSL -o d.pdf <URL>; wc -c d.pdf; shasum -a 256 d.pdf`).
- `sources` row, with every required column [V] (columns and defaults read from the table):

| column | value |
|---|---|
| id | `3a0e5ca1-0000-4000-8000-0000000003a1` |
| name | `TEST 3a originals — do not schedule` |
| domain | `www.w3.org` |
| start_url | the file URL |
| collection_method | `http` |
| is_active | `true` |
| schedule_enabled | `false` |
| tos_status | `unknown` |
| robots_status | `unknown` |
| is_official_domain | `false` |
| is_primary_document | `false` |
| traceability_level | `direct_url` |
| institution_class | `unknown` |
| crawler_type | `cheerio` (not used by `http` sources) |
| proxy_config / apify_actor_id / include_url_globs | `NULL` |
| notes | `TEST:phase1b-3a` |
| created_at / updated_at | `now()` |

- Why the scheduler won't pick it up [V] (code and cron list):
  - In `test` mode, files are stored only on manual runs that ask for it.
  - The scheduled caller never asks.
  - The generic scheduler needs `schedule_enabled=true`.
  - The 9 active cron jobs call only fixed country routes.

## Settings for the single attempt
- `ORIGINALS_STORAGE_MODE=test`
- `ORIGINALS_INLINE_EXTRACT_MAX_BYTES=1048576`

## Cost
- Normal path: one free download, about 26 KB of storage traffic and about 10 database writes [N].
- Parallel: at most 1 call, with no automatic retry. I couldn't determine the price per call, so nothing runs until the owner authorizes that cost.
- If the fallback happens, the run must record that "original PDF + local extraction" was NOT demonstrated, even if text was collected.
- If Parallel also fails: 1 blocked record and 1 alert email to ops@auramaris.app. No Webshare, because the source has no proxy [V].

## Expected on the success path [N]
- 1 job, `succeeded`, with `run_params.originals`.
- 1 raw_item for the test source.
- 1 `document_copies` row:
  - `storage_status='stored'` with `stored_at` set [V] (allowed states are pending/stored/missing/conflict);
  - `storage_bucket='document-originals'`;
  - `storage_path = sha256/<2 hex>/<hex>` [V] (enforced by a CHECK).
- 1 Storage object at that path.
- 1 `document_copy_sightings` row: `copy_id`, `raw_item_id`, `source_id`, `collection_job_id`, `fetch_method='http'`, `byte_outcome='stored'`.
- 1 `document_extractions` row: `copy_id`, `extractor_version='unpdf@1.8.1'`, `text_sha256_exact`, `char_count`, `truncation_status`, and `text_inline` set with `text_storage_path` null.
- Never created: legal documents, versions, approvals or normalized items.
- Starting point [V]: copies, sightings, extractions and stored files are all 0. raw_items is 1210 and jobs is 282. Two old jobs are still running and won't be touched.

## Checks
- Before the run: row counts for the affected tables and the state of the two old jobs.
- After the run:
  - The copy's hash and size must equal the owner's values.
  - The links must hold as described above.
  - All new rows must belong to the test source or job.
  - Earlier rows must be unchanged.
- Independent check: the owner downloads the stored file through a 300-second signed link and compares its size and SHA-256. This is a check, not a second collection.

## Back to off, after the single attempt (success or failure)
- The owner deletes both secrets.
- Keep every id, path and file. Nothing gets deleted or repeated.
- The 3a pilot then closes with its documented limitations, and work moves to the discovery queue.

## Single authorization request (once the STOP above is resolved)
The owner approves, in one go:
1. Create the test source as listed above.
2. Set the two secrets.
3. Make one manual call, with one URL, through the chosen option.
4. Allow at most 1 Parallel call, at its price.
5. Allow only the writes listed above.
6. Run the checks, including the signed-link download.
7. Delete the secrets afterwards.
