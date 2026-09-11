# Build spec — OryxScrape → AuraMaris Drive handoff (pilot)

Approved decisions folded in. Nothing is created in Google Drive and no migration runs until you confirm the two Google identities.

## 1. Exact affected tables and migration

One migration, additive only. No existing table, RPC, trigger or public response shape is modified. `api_list_items` is untouched, so the public API keeps returning only `reviewed + eligible` items and AuraMaris still gets no key.

**New enums**
- `exchange_handoff_state`: `pending | feedback_received | accepted | rejected | error`
- `exchange_suppression_kind`: `sha256 | normalized_url | identifier_date | title_issuer_date | weak_filename`
- `search_term_lifecycle`: `candidate | promising | validated | ambiguous | cooldown | disabled_auto | manual_only | deprecated`

**`public.exchange_handoffs`**
```
id uuid pk default gen_random_uuid()
exchange_item_id uuid not null unique default gen_random_uuid()
normalized_item_id uuid not null references public.normalized_items(id)
artifact_kind text not null default 'extracted_text_only'
original_artifact_available boolean not null default false
content_integrity_scope text not null default 'normalized_extracted_text'
artifact_sha256 text not null
artifact_filename text not null
artifact_mime_type text not null default 'text/plain; charset=utf-8'
artifact_size_bytes bigint not null
country_code text            -- confirmed by a human at packaging time
language_code text           -- confirmed by a human at packaging time
drive_folder_id text, drive_artifact_file_id text, drive_metadata_file_id text
state exchange_handoff_state not null default 'pending'
sent_at timestamptz, auramaris_decision text, auramaris_decision_at timestamptz
reason_code text, reason_detail text
drive_feedback_file_id text, drive_ack_file_id text
last_synced_at timestamptz, error_reason text
created_at/updated_at timestamptz not null default now()
```
Indexes: `unique (normalized_item_id) where state <> 'error'`; `unique (drive_feedback_file_id) where drive_feedback_file_id is not null`; index on `state`.

**`public.exchange_suppressions`**
```
id uuid pk, exchange_item_id uuid references public.exchange_handoffs(exchange_item_id)
rule_kind exchange_suppression_kind not null
match_value text not null
strength text not null            -- 'hard_skip' only for sha256; else 'review_signal'
country_code text, concept_code text
reason_code text, reason_detail text
is_active boolean not null default true, expires_at timestamptz
created_at/updated_at
```
`unique (rule_kind, match_value) where is_active`. Per decision 5, only `rule_kind='sha256'` may carry `strength='hard_skip'`; a CHECK enforces that every other kind is `review_signal`.

**`public.search_terms`** (passive lexicon)
```
id uuid pk, concept_code text not null, concept_label text not null
country_code text, language_code text
term text not null, synonym_group text, target_domain text
attempt_count int not null default 0, useful_count int not null default 0
false_positive_count int not null default 0, credit_cost_estimate numeric
lifecycle_state search_term_lifecycle not null default 'candidate'
cooldown_until timestamptz, retry_after timestamptz
reactivation_reason text, last_run_at timestamptz, notes text
created_at/updated_at
unique (concept_code, term, coalesce(country_code,''))
```
Seed inside the same migration from the historical France runs already in `collection_jobs.run_params` (15 concepts) — counts derived from existing jobs/normalized items, no re-crawling. Passive only: nothing in the codebase reads `lifecycle_state` to skip a query in this pilot.

All three tables: `GRANT SELECT, INSERT, UPDATE ON ... TO authenticated`, `GRANT ALL ... TO service_role`, no `anon` grant, RLS enabled, staff-only policies mirroring the existing tables, no DELETE policy. Each gets the existing `set_updated_at` trigger.

**Not added:** no `country_code`/`language_code` on `normalized_items` (decision 3) — they live only on the handoff row, derived at packaging and human-confirmed.

## 2. Exact UI / routes / files to change

**New files**
- `src/lib/drive.server.ts` — Drive v3 through the connector gateway, `supportsAllDrives=true`; create folder, upload file, list folder, get file content. Server-only.
- `src/lib/exchange.server.ts` — artifact building (extracted text from `normalized_items.payload`), sha256, `metadata.json` assembly, feedback Zod schema, ack assembly.
- `src/lib/exchange.functions.ts` — authenticated server functions: `listHandoffCandidates`, `packageAndSendHandoff` (staff-confirmed country/language), `listHandoffs`, `syncExchangeFeedback` (manual, idempotent), `listSuppressions`.
- `src/lib/search-terms.functions.ts` — `listSearchTerms`, `setSearchTermLifecycle` (human-set cooldown/manual_only/disabled_auto), `exportSearchTerms` to `05_Search_Terms_Shared`.
- `src/routes/_authenticated/exchange.tsx` — Exchange screen: candidate list (reviewed + eligible only), send dialog with country/language confirmation, handoff table with state badges, "Sync exchange feedback" button, suppression list.
- `src/routes/_authenticated/lexicon.tsx` — Search Lexicon table with lifecycle badges + manual state controls + export button.

**Changed files**
- `src/components/app-shell.tsx` — two nav entries (Exchange, Lexicon).
- `src/lib/items.functions.ts` — add `eligible_for_handoff` wording to the returned status labels only; **no enum rename**, no transition-matrix change.
- `src/routes/_authenticated/items.tsx` — label "eligible" as "eligible for external handoff" and add a "Send to exchange" link for eligible items.
- `roadmap.md` — Phase 6 progress.

**No jobs/schedulers.** Feedback sync is a button only (decision 4). No changes to `src/routes/api/public/v1/items.ts`, `api_list_items`, consumer keys, Apify, PISTE or LogoriOn code.

**Manifest additions** beyond the agreed shape, per decision 2:
```json
"artifact": { "...": "...", "artifact_kind": "extracted_text_only",
              "original_artifact_available": false,
              "content_integrity_scope": "normalized_extracted_text" },
"handoff": { "oryx_verification_status": "reviewed",
             "oryx_publication_status": "eligible_for_handoff",
             "do_not_auto_import": true,
             "official_artifact_verified": false,
             "automation_eligible": false }
```

## 3. Permission setup checklist (you do this in Google, I build nothing until confirmed)

1. Create Shared Drive `OryxScrape-AuraMaris Exchange` (Shared Drive, not My Drive).
2. Create two technical identities — Google Cloud service accounts are preferred (`oryxscrape-exchange@<project>.iam.gserviceaccount.com`, `auramaris-intake@<project>.iam.gserviceaccount.com`); Workspace user accounts work equally well if service accounts are not available.
3. Add both to the Shared Drive: OryxScrape identity as **Contributor**, AuraMaris identity as **Contributor**. Neither may be Manager.
4. Create the five top-level folders exactly as specified. Apply per-folder overrides: OryxScrape identity → Contributor on `01_Pending_Review`, `04_Rejection_Feedback`, `05_Search_Terms_Shared`; Viewer on `02_Accepted`, `03_Rejected`. AuraMaris identity → Viewer on `01_Pending_Review` and `05_Search_Terms_Shared`; Contributor on `02_Accepted`, `03_Rejected`, `04_Rejection_Feedback`.
5. Shared Drive settings: only Managers may move/delete content; sharing outside the organisation off; download/copy restricted to members.
6. The existing connected "Auramaris Google Drive" account acts **only as human administrator** (Manager) — it is not used as either system identity.
7. Send me: the Shared Drive ID, the five folder IDs, and confirmation that the OryxScrape identity's credential is available as a project secret (I will name it `GOOGLE_DRIVE_EXCHANGE_CREDENTIALS`).

Until step 7 lands, I build and test everything except live Drive calls, which stay behind an explicit "not configured" error.

## 4. Test matrix

| # | Test | Expected |
|---|---|---|
| 1 | Package an `unreviewed` or `rejected` item | Refused server-side |
| 2 | Package a `reviewed + eligible` item | Folder + `artifact.txt` + `metadata.json` created; row `pending` |
| 3 | Send the same item twice | Blocked by the partial unique index; no second Drive folder |
| 4 | Retry after simulated Drive failure | Same `exchange_item_id` reused; no duplicate files; `error_reason` cleared on success |
| 5 | `metadata.json` inspection | No tier, policy, profile, reviewer, credential, prompt or raw payload; correct `artifact_kind`/`official_artifact_verified: false` |
| 6 | sha256 in manifest vs uploaded bytes | Identical |
| 7 | Country/language left unconfirmed | Send button disabled |
| 8 | Valid rejection feedback | State `rejected`, one `sha256` hard-skip suppression, one `.ack.json` with `status: processed` |
| 9 | Feedback for unknown `exchange_item_id` / bad schema | State `error`, ack `status: failed`, no suppression |
| 10 | Sync run twice | Idempotent on `drive_feedback_file_id`; ack written once |
| 11 | Re-send a suppressed artifact | Blocked by exact sha256 |
| 12 | Re-send same document with different bytes | Allowed (no hard block from URL/title/size) |
| 13 | Term with a rejected document | Lifecycle unchanged; only `false_positive_count` increments |
| 14 | Public API before/after | `/api/public/v1/items` response byte-identical |
| 15 | anon / authenticated direct RPC | Still denied; security linter clean |
| 16 | Lexicon export | CSV+JSON in `05_Search_Terms_Shared`, no prompts/credentials/live logic |

## 5. Rollback plan

Additive-only, so rollback is cheap and cannot affect collection, review or the public API:
1. Hide the Exchange and Lexicon nav entries and revert the two touched item files (label + link only).
2. Set any open handoffs to `error` with an explicit reason; Drive files stay in place as evidence (nothing is deleted).
3. If a full revert is wanted, a follow-up migration drops the three new tables and three enums — no existing object depends on them.
4. Suppression rows are the only thing that could change future collection behaviour; deactivating them (`is_active = false`) restores prior behaviour without data loss.

## 6. Remaining blockers before I write code

- Google-side setup confirmed (checklist §3, item 7).
- Which 8–12 of the 43 items form the pilot. All 43 are currently `unreviewed`, so each pilot item must first be reviewed and marked eligible by you in the Collected items screen. The local/island/port-authority case is recorded as a post-pilot acceptance scenario.
