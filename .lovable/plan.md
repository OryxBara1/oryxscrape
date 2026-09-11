# OryxScrape → AuraMaris Drive handoff (design only)

No code, schema, Drive folders, credentials or deployments are created by this plan.

## 1. Current-state map (verified)

**Database (Supabase `nlthswnojvkqpooztans`), real column names:**

- `sources`: id, name, domain, start_url, collection_method, is_active, notes, tos_status/tos_url/tos_checked_at, robots_status/robots_checked_at, is_official_domain, is_primary_document, traceability_level, institution_class, crawler_type, include_url_globs, created_at, updated_at
- `collection_jobs`: id, source_id, profile_id, status, started_at, finished_at, fetched_count, new_count, duplicate_count, failed_count, error_text, run_params (jsonb — already carries the concept list), apify_run_id, timestamps
- `raw_items`: id, job_id, source_id, source_url, raw_payload, content_hash, collected_at, collection_method, four objective facts, canonical_url, http_status, content_type, language, apify_actor_id, apify_run_id, collector_version
- `normalized_items`: id, raw_item_id, source_id, source_url, jurisdiction_hint, category, payload (jsonb — holds title, text, concept_label, concept_query), four objective facts, collected_at, verification_status, publication_status, reviewed_by, reviewed_at
- `normalized_item_profile_exposure`, `consumer_keys`, `audit_events` (check_type, target_table, target_id, profile_id, result, findings, run_at)

**Content today:** 11 sources, 44 raw items, 43 normalized items — **all 43 are `unreviewed` / `internal_only`**. Nothing has ever been reviewed, so the pilot starts from a clean gate.

**Review lifecycle in code:** `setItemReviewState` in `src/lib/items.functions.ts` enforces a fixed transition matrix (review / reject / reopen / mark_eligible / set_internal_only), stamps `reviewed_by` + `reviewed_at` from the verified session, and uses state-guarded updates. Status changes are audit-logged by a DB trigger. The Collected items screen renders status badges and only the legal controls.

**Public API:** `/api/public/v1/items` → `api_list_items` (SECURITY DEFINER, service-role only) already filters `reviewed + eligible`. This stays as-is; **AuraMaris is never issued a consumer key.**

**Gaps found:** no `country_code` column (only free-text `jurisdiction_hint`, sometimes "ES"/"HR" and sometimes "République française"); no `language_code` on normalized items (language lives on `raw_items.language`, often NULL); no artifact/binary store — `raw_payload` holds crawler JSON/text, and there is no per-artifact sha256 (only `raw_items.content_hash` over extracted content); no search-terms table (concepts live only inside `collection_jobs.run_params` and normalized payloads).

**Google Drive capability:** a workspace connection "Auramaris Google Drive" (OAuth2, gateway-backed) exists but is **not linked to this project**. Gateway access is Drive API v3, so shared drives are reachable, but every call requires `supportsAllDrives=true` / `includeItemsFromAllDrives=true`, and the connection authenticates **one Google identity** — it is not a per-system service account. This is the single largest open decision (see §11).

## 2. Architecture and trust boundaries

```text
OryxScrape (Supabase + TanStack server fns)
   |  human review gate (existing) -> reviewed + eligible
   |  handoff packager (new, staff-triggered)
   v
Google Shared Drive "OryxScrape-AuraMaris Exchange"   [evidence vault + queue]
   |  01_Pending_Review/<exchange_item_id>/
   v
AuraMaris intake (out of scope here) -> canonical acceptance decision
   |  02_Accepted/<country_code>/ | 03_Rejected/ | 04_Rejection_Feedback/
   v
OryxScrape feedback poller -> validate -> tracking + suppression -> .ack.json
```

Boundaries: no API, no DB link, no webhook, no consumer key between the systems. Drive is the only channel. Drive never holds canonical state: OryxScrape owns collection/review/handoff/query intelligence/suppression; AuraMaris owns intake/legal classification/acceptance. A file move in Drive changes nothing in either database.

**Terminology:** the existing enum value `publication_status = 'eligible'` is **not renamed**. Every new field, doc string, UI label and metadata key spells it **"eligible for external handoff/review"** — never "eligible for AuraMaris". `metadata.json` reports the literal string `eligible_for_handoff` in `handoff.oryx_publication_status`, mapped from the enum at packaging time, plus `do_not_auto_import: true`.

## 3. Schema proposal (real names, one migration)

**`public.exchange_handoffs`** — one row per sent artifact (operational sync record, not a decision record):

- `id uuid pk`, `exchange_item_id uuid not null unique default gen_random_uuid()`
- `normalized_item_id uuid not null references normalized_items(id)`
- `artifact_sha256 text not null`, `artifact_filename text`, `artifact_mime_type text`, `artifact_size_bytes bigint`
- `drive_artifact_file_id text`, `drive_metadata_file_id text`, `drive_folder_id text`
- `state exchange_handoff_state not null default 'pending'`
- `sent_at timestamptz`, `auramaris_decision_at timestamptz`, `auramaris_decision text`, `reason_code text`
- `drive_feedback_file_id text`, `drive_ack_file_id text`, `last_synced_at timestamptz`, `error_reason text`
- `created_at/updated_at` + existing `set_updated_at` trigger
- unique partial index on `(normalized_item_id)` where `state <> 'error'` — one live handoff per item
- new enum `exchange_handoff_state`: `pending | feedback_received | accepted | rejected | error`

**`public.exchange_suppressions`** — created only from validated feedback:

- `id uuid pk`, `exchange_item_id uuid references exchange_handoffs(exchange_item_id)`
- `rule_kind exchange_suppression_kind` (`sha256 | normalized_url | identifier_date | title_issuer_date | weak_filename`)
- `match_value text not null` (hash / normalized URL / composite key), `country_code text`, `concept_code text`
- `strength text` (`hard_skip | soft_skip | review_candidate`), `reason_code text`, `reason_detail text`
- `is_active boolean default true`, `expires_at timestamptz null`, timestamps

**`public.search_terms`** — needed; today's concept data is unstructured inside `run_params`. Columns: `id`, `concept_code`, `concept_label`, `country_code`, `language_code`, `term`, `synonym_group`, `target_domain`, `attempt_count`, `useful_count`, `false_positive_count`, `credit_cost_estimate numeric`, `lifecycle_state` (enum: `candidate | promising | validated | ambiguous | cooldown | disabled_auto | manual_only | deprecated`), `cooldown_until`, `retry_after`, `reactivation_reason`, `last_run_at`, timestamps. The 15 France concepts already run become the first seed, populated from `collection_jobs.run_params` — historical only, no re-crawling.

All three tables: deny-by-default RLS, `GRANT ... TO authenticated` for staff read/write via server functions, `GRANT ALL TO service_role`, no `anon` grant. `api_list_items` is untouched — none of this reaches the public API.

**Not proposed now:** no `country_code`/`language_code` column on `normalized_items`. Instead the packager derives them at handoff time (ISO-3166-1 alpha-2 from the source's domain/jurisdiction_hint, ISO-639-1 from `raw_items.language`), and the staff confirms them in the handoff dialog. Adding normalized columns is a separate later decision (§11).

## 4. State transitions

```text
normalized_items:  unreviewed -> reviewed -> (eligible = eligible for external handoff)
                        \-> rejected (internal, never handed off)

exchange_handoffs: (none) -> pending            [artifact + metadata uploaded to 01_Pending_Review]
                   pending -> accepted          [Accepted disposition observed / feedback decision accepted]
                   pending -> feedback_received [feedback JSON found and validated]
                   feedback_received -> rejected [ack written, suppression rows created]
                   any -> error                 [upload, validation or ack failure; error_reason set]
```

Preconditions for `pending`: item is `reviewed` **and** `eligible`, has no active non-error handoff, and its artifact sha256 matches no active `hard_skip` suppression. Nothing auto-promotes: a staff member clicks "Send to exchange".

## 5. Folder and permission model

Fixed MVP tree exactly as specified, on a **Shared Drive** (not a My Drive), with `02_Accepted/<country_code>/` created by AuraMaris on demand. Copy, never move: the original stays in `01_Pending_Review` and OryxScrape marks it processed internally.

| Principal | 01_Pending | 02_Accepted | 03_Rejected | 04_Feedback | 05_Search_Terms |
|---|---|---|---|---|---|
| OryxScrape service identity | write (create only) | read | read | read + create `*.ack.json` | write |
| AuraMaris service identity | read | write | write | write (`<id>.json`) | read |
| Human administrators | Content manager on the Shared Drive | | | | |

Shared Drive settings: downloads/copies restricted to members, non-members cannot be added to files, deletion restricted to Managers. Neither service identity gets Manager. No deletion of any artifact, feedback or ack file without the explicit retention policy in §10. OryxScrape holds no AuraMaris Supabase credentials and vice versa.

## 6. Contracts

**Outgoing** — `01_Pending_Review/<exchange_item_id>/{artifact.*, metadata.json, extracted.txt?}` with exactly the `schema_version 1.0` shape given in the request. Field sourcing: `normalized_item_id` ← `normalized_items.id`; `collected_at` ← `normalized_items.collected_at`; `artifact.sha256` ← sha256 of the exact uploaded bytes (recomputed at packaging; not reused from `raw_items.content_hash`); `candidate.title/concept_code/concept_label` ← `normalized_items.payload`; `legal_identifier`/`publication_date` ← payload when stated, otherwise `null` — never inferred; `source.source_url` ← `normalized_items.source_url`; `official_landing_url` ← `raw_items.canonical_url`. Excluded by construction: tier/policy fields, profile data, reviewer identity, audit events, prompts, credentials, key hashes, raw crawler payload.

**Incoming** — `04_Rejection_Feedback/<exchange_item_id>.json`, validated with a strict Zod schema matching the given shape: unknown `exchange_item_id`, wrong `schema_version`, or malformed body → handoff goes to `error` with `error_reason`, and an ack is still written marking `failed`.

**Ack** — `04_Rejection_Feedback/<exchange_item_id>.ack.json`: `{ schema_version, exchange_item_id, status: "processed"|"failed", processed_at, suppression_created: bool, suppression_rules: [rule_kind...], error_reason: string|null }`.

## 7. Dedupe / suppression model

Applied in the stated priority, as a pre-handoff check and a pre-collection filter:

1. `sha256` → hard skip the exact artifact.
2. normalized URL (lowercase host, strip fragment/tracking params, drop trailing slash) → soft skip + lightweight revalidation; a changed hash re-opens the item.
3. country + legal_identifier + series/issue + publication_date → strong dedupe candidate, flagged in the UI, never auto-deleted.
4. normalized title + issuer + date → review candidate.
5. filename + publication_date + size_bytes → weak only; queues a confirmation task, never blocks.

`suppress_identifier_for_same_concept: false` is honoured as sent. A rejection **never** touches `search_terms.lifecycle_state` beyond incrementing `false_positive_count`; no term is ever globally disabled from one rejection.

## 8. Search intelligence and retry policy

`05_Search_Terms_Shared/search_terms_<YYYY-MM-DD>.csv` + `.json`: a periodic, manually triggered, read-only export of `search_terms` (concept, country, language, term, synonym group, target domain, attempt/useful/false-positive counts, lifecycle state, cooldown) — no live logic, no prompts, no credentials.

Retry: `candidate` → `promising` after ≥1 useful hit → `validated` after ≥3 useful with false-positive rate <30%; false-positive rate >70% over ≥5 attempts → `ambiguous` and a 14-day `cooldown`; repeated failure → `disabled_auto` (still runnable manually) or `manual_only`. `deprecated` requires a human. Reactivation always records `reactivation_reason`. Search construction rules unchanged: OR only between interchangeable synonyms of one concept, AND only to disambiguate, one query per concept, deterministic search for exact legal identifiers, official/competent domains preferred.

## 9. Pilot and test matrix

10 documents from the existing 43, each reviewed and marked eligible by hand first (nothing is currently reviewed):

1–2. BOE direct official/national (the validated nautical decree + one bulletin document)
3. Croatian *Pomorski zakonik* consolidated act (official, primary)
4. A second Croatian issue of the same act → supersession/duplicate scenario
5. Germany BGB page (official, structural/low-value content) → expected rejection
6. A Croatian listing page normalized as `otro` → expected false positive
7–8. Two France PISTE items with `concept_label` traceability
9. The France port_mooring_fees mismatch → expected reason_code `off_topic`
10. A France item with NULL jurisdiction → tests `country_code` confirmation in the packager

Local/insular/AMP/port authority and government-mirror cases are **not present** in the current 43 — noted as a pilot gap, not fabricated.

Test matrix: unreviewed item cannot be packaged; rejected item cannot be packaged; duplicate send blocked by the unique index; upload retried after simulated Drive failure produces no second copy (idempotent on `exchange_item_id`); malformed feedback → `error` + failed ack; valid rejection → suppression + ack + re-send blocked by sha256; ack written exactly once; metadata.json contains no tier/policy/credential/reviewer field; `api_list_items` output unchanged; Drive read with the AuraMaris identity cannot write to 01_Pending; anon/authenticated RPC denial unchanged; security linter clean.

## 10. Security, idempotency, retention, rollback

- Drive calls only from server functions through the connector gateway; no Drive token in the browser; no Drive identity stored in the database.
- Idempotency key is `exchange_item_id`; every Drive write first looks up an existing file id in `exchange_handoffs` before creating. Feedback processing is guarded by `drive_ack_file_id IS NULL`.
- Retention: artifacts, feedback and acks retained indefinitely during the pilot; deletion only by a human Manager with an audit_events entry. `audit_events` records every handoff send, feedback ingest and suppression creation.
- Rollback: the feature is additive — disable the "Send to exchange" control, stop the feedback poller, and set open handoffs to `error`. No existing table, RPC or public response shape changes, so rollback cannot affect collection, review or the public API.

**Future AuraMaris intake contract (out of scope to build):** read-only poll of `01_Pending_Review`; validate `metadata.json` schema_version and sha256 against the artifact bytes; treat `do_not_auto_import: true` as blocking automation; record its own canonical decision; copy to `02_Accepted/<country_code>/` or `03_Rejected/`; write exactly one `04_Rejection_Feedback/<exchange_item_id>.json` per non-acceptance; never write to OryxScrape's database; never downgrade a source solely for being sub-national.

## 11. Human decisions required before Build Mode

1. **Drive identity.** The only Drive connection here is one OAuth2 user connection ("Auramaris Google Drive") not linked to this project — one Google identity, not two service accounts. Least-privilege separation as designed needs two distinct principals. Choose: (a) create two Google service accounts and share the Shared Drive with each, or (b) accept a weaker pilot where one identity acts for both sides and separation is procedural only.
2. **Artifact format.** We do not currently store original bytes — only crawler-extracted text/JSON. Options: (a) ship `artifact.txt` from stored content plus `extracted.txt`, or (b) add an original-bytes fetch/store step (larger scope). MVP assumption unless told otherwise: (a).
3. **country_code / language_code.** Assumed derived at packaging with staff confirmation, not added to `normalized_items`. Confirm, or approve normalized columns instead.
4. **Feedback discovery.** Assumed a staff-triggered "Sync exchange feedback" button (no scheduling — scheduling remains out of scope). Confirm.
5. **Search terms scope.** Confirm the new `search_terms` table plus historical seed from `run_params`, with no re-crawling.
6. **Pilot gap.** No local/insular/port-authority or mirror source exists in the current 43. Accept a 10-document pilot without those cases, or collect them first.
