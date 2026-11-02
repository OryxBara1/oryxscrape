# Discovery Queue, Document Versions and Layering — Revised Design (no SQL yet)

OryxScrape is an independent internal tool. This work finds documents and the paths to obtain them. "Approve" only authorizes the next operational step inside OryxScrape. It never means official, in force, legally validated or publishable. No consumer connection, sync, export or reference.

## 0. What the real schema shows today (inspected)

- **Staff check:** both `is_staff()` (no args, uses `auth.uid()`) and `is_staff(uuid)` exist. Both are SECURITY DEFINER with search_path locked. EXECUTE is revoked from anon/public and granted to authenticated and service_role. Existing table policies use `is_staff(auth.uid())`. New tables follow the same pattern and add no new definer functions.
- **raw_items** is append-only (INSERT/SELECT only; UPDATE and DELETE denied). It is unique on `(source_id, content_hash)`. Version-like fields already exist: `supersedes_raw_item_id`, `canonical`, `payload_integrity` (verbatim/partial/synthesized), `item_status` (collected/failed/pending/superseded/blocked) and `canonical_url`.
- **Supersedes today** is used by the Manual Upload Queue (a manual row supersedes a `blocked` row), Malta, EUR-Lex and the legacy flows. A "done" check means "some row supersedes me". The old row is never updated.
- **Exposure today:** GET /feed reads `normalized_items` through supabaseAdmin with:
  - `publication_status='eligible'`
  - a profile jurisdiction/tag filter
  - `normalized_item_profile_exposure.promoted=true` when `require_promotion` is set.

  `api_list_items` also requires `verification_status='reviewed'`. A trigger blocks `rejected`+`eligible`. Raw rows are never exposed. So a working layer (raw_items plus anything not eligible) and an exposed layer (eligible plus promoted) already exist.
- **Gap:** raw_items has no document identity across sources or URLs, no quality grade, no defect reason and no source version label. Its `canonical` boolean cannot be flipped later, because rows are immutable.

## 1. Phase 1 proposals (separate migrations, each approved on its own)

### 1A — Discovery queue (provider-agnostic)

Three tables:

**`discovery_runs`**
- Columns: provider (free text plus a check list: `ldh`, `parallel_search`, `manual`, `other`), started_at, finished_at, heartbeat_at, `status` (running / succeeded / partial / failed / budget_exhausted / interrupted), error_text, credits_reserved, credits_used, triggered_by.
- `error_text` is required for every non-success status.

**`discovery_queries`** (one row per call)
- Columns: run_id, query_text, params (country, language, namespace), status, http_status, error_text, credits, result_count.
- This gives the link candidate → query → run.

**`discovery_candidates`**
- **Origin, never edited after insert:** run_id, query_id, provider, provider_ref (jsonb: source and source_id only), found_url (nullable, stored exactly as returned), found_title, found_identifier (norm number, ELI/CELEX, publication reference), found_at.
- **Working fields:**
  - country_code, language, doc_type_guess
  - relevance_note (our own words, ≤280 characters)
  - confirmed_source_url (nullable)
  - document_id (nullable FK to 1B)
- **Per-field confidence:** jsonb `{title, url, identifier, country: 'hypothesis' | 'confirmed'}`.
- **Stage** (progressive, see below), `outcome_reason`, reviewed_by, reviewed_at, source_id, collection_job_id.
- **Dedup keys:** `key_provider`, `key_identifier`, `key_url`. All are nullable, and each has a partial unique index.
- **Constraints:** at least one of found_url, found_identifier or found_title is required. A CHECK forbids text-like keys (`snippet`, `text`, `full_text`, `excerpt`, `content`, `body`) in provider_ref.
- **No provider text** is ever stored in any row, log or error.

**Stage model**

```text
lead -> identified -> source_located -> collection_decided -> retrieval_attempted -> retrieved_verified
side outcomes (not terminal, all reopenable): not_found | access_failed | out_of_scope | duplicate | rejected
```

- `access_failed` keeps the document and allows another location through the unchanged hierarchy (official API → Parallel → Apify/Webshare → recordBlockedItem).
- Only `out_of_scope` and `rejected` are human decisions. Both can be reopened by staff.

**Dedup (conservative)**
- An insert first matches on provider key, then on normalized identifier, then on canonicalized found_url.
- A match does not drop the new row. It is inserted as `duplicate` with `duplicate_of_candidate_id`, so the origin trail stays intact.
- Matches against raw_items `source_url`/`canonical_url` set `stage=retrieval_attempted` plus a link. They are not discarded.
- Two candidates found to be the same later are linked through `document_id` (1B). Nothing is deleted.

### 1B — Document identity and versions (minimal addition to raw_items)

- **New `documents` table** (the identity of a document across sources):
  - title, identifier, country_code, jurisdiction, status_note
  - `preferred_raw_item_id` (the promoted best copy; it can change, because this table is mutable and raw_items is not)
  - created_at, updated_at
- **New `raw_item_assessments` table**, append-only, so assessments can change without mutating raw_items:
  - raw_item_id, document_id
  - `quality` (clean / defective / truncated / unreadable / unknown), defect_reason
  - source_version_label, in_force_from
  - assessed_by, assessed_at
  - The latest row wins.
- **One new raw_items column:** `document_id uuid null`, set at insert time.
- **Reused:** `content_hash`, `supersedes_raw_item_id` (a new copy points to the previous copy of the same document), `payload_integrity`, `item_status`, `collected_at`, `collection_method`.
- **New copies:**
  - A new hash for the same document produces a new raw row. The old row is kept.
  - The same hash is ignored by the existing unique constraint, and its re-check result is recorded as an assessment.
  - Promotion is an explicit staff action that updates `documents.preferred_raw_item_id`.
- **Defective copies are never blocked.** A "Re-check defective" action re-runs collection through the existing hierarchy for documents whose preferred copy is not `clean`. It is manual only; scheduling comes later via the SQL editor.
- **Conflict:** a defective copy today may carry `item_status='collected'`. It stays that way, and quality lives in assessments rather than overloading `item_status` (which describes retrieval, not quality).

### 1C — Layering (recommendation: same schema, existing mechanism)

| Option | Pros | Cons |
|---|---|---|
| A. Same `public` schema; the working layer is raw_items plus the new tables plus normalized_items not eligible; the exposed layer is `normalized_items` eligible (+ promoted) | Already how /feed works; no feed contract change; RLS unchanged | Separation is by filter, so discipline is needed |
| B. Separate `working` schema for discovery/assessments | Hard isolation from the Data API | Generated types/grants work, cross-schema FKs, more RLS surface; PostgREST needs schema exposure |
| C. Layer/visibility column on normalized_items | Explicit | Duplicates `publication_status` + promotion |

**Recommendation: A.**
- Add one guard: promotion to `eligible` must require the normalized item's raw copy to have a latest assessment of `clean`, and the source must be official.
- This is enforced in the existing review transition trigger (a change for 1C, separately approved).
- Provenance (found_url, provider, run, query, retrieval method, hash, timestamps) stays readable at every layer, and nothing is ever rewritten.

## 2. Impact on Phases 2 and 3

**Phase 2 (`/admin/discovery`, staff only)**
- List and filter by stage, provider, country and confidence.
- Actions: advance stage, mark not_found / out_of_scope, reopen, link to a document, link to a source.
- Bulk JSON/CSV import (provider `manual`, per-row result: inserted / duplicate / invalid with reason).
- A documents view showing copies, assessments and the promoted copy, with a "Re-check defective" button.
- "Approve" equals `collection_decided` and starts nothing by itself.

**Phase 3 (provider integration)**
- Each provider is a module behind one interface: `search(query) -> {found_url?, title?, identifier?, provider_ref}`.
- LDH requirements and limits will be presented separately before activation (key name, terms, rate, budget).
- Reliability controls:
  - Rolling 24 h budget = sum of credits over the last 24 h.
  - Atomic reservation: `credits_reserved` is set by a single conditional insert or update that refuses when the window is full, so two runs cannot spend the same balance.
  - Heartbeat + timeout: `running` with no heartbeat for over 10 min becomes `interrupted` on the next run or page load.
  - 429 becomes an explicit failed query with no blind retry.
  - Errors are recorded with status codes only, never with headers or keys.

## 3. Decisions for the owner

1. Layering: option A (recommended), or B or C?
2. Should `document_id` live on raw_items (one new nullable column), or only in a link table so raw_items is untouched?
3. Quality grades: is clean / defective / truncated / unreadable / unknown enough? Who may assess — staff, or also automated heuristics as "hypothesis"?
4. Should promotion to `eligible` hard-require a `clean` assessment (a trigger), or only show a UI warning?
5. Should re-check also run for `clean` documents at a slow cadence, to catch source corrections?
6. Should `rejected` / `out_of_scope` hide a candidate from rediscovery matches, or keep it showing as a reopenable match?
7. Budget window: rolling 24 h, or provider calendar day? What default cap?
8. Is the stage list acceptable, or should any step be merged?

## 4. Real constraints

- **Cloudflare Workers:** no HTTP proxy in fetch, request-time limits (runs must be short or chunked), no Node APIs, secrets read inside handlers only. No Edge Functions and no pg_cron from Lovable.
- **raw_items immutability:** all "mutable" state (quality, promotion, document link changes) must live outside raw_items or be set at insert time.
- **GET /feed contract must not change:** it keeps reading `normalized_items` eligible (+ promoted), with the same fields, cursors and filters. New tables are never read by the feed.
- **Existing triggers:** the review-transition trigger, the review audit trigger and the tier policy remain authoritative. Any 1C guard extends them; it does not replace them.
- **Fixed chain:** the fallback chain and the exact-hostname API resolver stay unchanged.
- **Validation per migration:**
  - `SET LOCAL ROLE anon`: denied.
  - authenticated non-staff via jwt claims: 0 rows and writes refused.
  - staff: allowed, DELETE denied.
  - All checks run inside a rolled-back transaction, followed by the linter/advisors.

## 5. SQL

Final DDL for 1A, 1B and 1C will be written only after the decisions in section 3 are closed. Each will be submitted as its own migration.

## Note

`roadmap.md` cannot be edited in plan mode. These phases will be added to it once building starts.
