# Discovery Queue (Phase 1A final SQL) + revised 1B/1C design

OryxScrape is an independent internal tool. This work finds documents and the paths to obtain them. "Approve" only authorizes the next step inside OryxScrape: it never means official, in force, legally valid or publishable. No connection, sync or export to any other product.

## 0. Real access configuration (checked live, read-only)

Three separate mechanisms were checked against the connected database.

1. **Data API exposure.** PostgREST serves the `public` schema (the app's generated client uses it). The list of exposed schemas lives in the project's API settings, not in SQL. The `authenticator` role config shows only timeouts, so exposure cannot be proven from SQL. Owner check: Supabase Dashboard → API settings → "Exposed schemas" should list `public` (and `graphql_public`) only.
2. **Grants.**
   - **Default privileges matter.** Tables created by `postgres` in `public` automatically give `anon` and `authenticated` the privileges DELETE, TRUNCATE, REFERENCES and TRIGGER (`Dxtm`). So every new table must start with an explicit `REVOKE ALL`.
   - **Existing tables:** `anon` has no read or write on raw_items, normalized_items or sources.
   - **Pre-existing finding (not created by this work):** `anon` holds TRUNCATE on `search_terms` and `staff_members`. `authenticated` holds TRUNCATE on raw_items, normalized_items, sources, search_terms and staff_members.
     - TRUNCATE bypasses row-level security.
     - The Data API cannot issue TRUNCATE, so it is not reachable from the browser today.
     - It is still wider than intended, especially given the raw_items immutability rule.
     - Proposed fix: one separate migration (Phase 0, its own approval) running `REVOKE TRUNCATE, TRIGGER, REFERENCES ... FROM anon, authenticated`.
3. **RLS.** Enabled on all 13 existing public tables. Policies are staff-only via `is_staff(auth.uid())`. Both `is_staff()` and `is_staff(uuid)` exist, as SECURITY DEFINER with a locked search_path. EXECUTE is revoked from anon.

**Conclusion.** Keeping the same schema gives staff-only protection, provided that:
- new tables run `REVOKE ALL` before granting;
- grants go only to authenticated (plus service_role);
- every policy requires `is_staff`.

A private schema is not needed. Its only extra benefit would be hiding table names from the Data API, which RLS already makes return 0 rows.

**Storage.** No storage buckets exist yet.

## 1. Phase 1A — Discovery queue (FINAL SQL, not applied)

Scope:
- 3 tables and 1 trigger function.
- No changes to existing tables.
- No new SECURITY DEFINER functions.
- No provider-specific columns. LDH data appears only as values (`provider='ldh'`).

Design points:
- **Stage vs outcome.** The stage never moves backwards. Attempts and failures live in the collection trail (collection_jobs / raw_items), not in the candidate's stage.
- **Stages:** lead → identified → source_located → approved_for_collection → collected → reviewed_copy.
- **Outcome** (separate field): open, out_of_scope, rejected, duplicate. Anything other than `open` requires a reason. Every outcome can be reopened manually.
- **Retrieval state** (separate field): none, in_progress, access_failed, not_found, awaiting_retry. It never erases identification progress.
- **Import shortcuts.** An import that already brings identification, source and file may insert directly at a later stage. The import records which steps came pre-filled.
- **Original values are kept.** `found_*` fields are never changed after insert (enforced by a trigger). Confirmed values go in separate fields, and each field carries a confidence flag.
- **No provider text.** A CHECK constraint forbids text-like keys in `provider_ref`, and `found_title` is capped at 500 characters.
- **Dedup.**
  - Three nullable keys, each with its own unique index: provider id, normalized identifier, normalized URL.
  - A re-found lead never inserts an identical task. The app looks up the match first and records the sighting in `discovery_sightings` (run, query, time), so rejected items show "already rejected: reason" without being reopened.
  - Merging two candidates later uses `same_as_candidate_id`; nothing is deleted.

```sql
-- ===== Phase 1A: provider-agnostic discovery queue =====

create table public.discovery_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  status text not null default 'running'
    check (status in ('running','succeeded','partial','failed','budget_exhausted','interrupted','paused')),
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  finished_at timestamptz,
  calls_reserved integer not null default 0 check (calls_reserved >= 0),
  calls_used integer not null default 0 check (calls_used >= 0),
  provider_quota jsonb not null default '{}'::jsonb,  -- last reported limits/remaining (no secrets)
  error_text text check (error_text is null or length(error_text) <= 2000),
  triggered_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_runs_error_required
    check (status in ('running','succeeded') or error_text is not null),
  constraint discovery_runs_finished
    check ((status = 'running') = (finished_at is null))
);

create table public.discovery_queries (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.discovery_runs(id),
  search_term_id uuid references public.search_terms(id),
  purpose text not null default 'new' check (purpose in ('new','recovery','reformulation','urgent')),
  query_text text not null check (length(btrim(query_text)) > 0 and length(query_text) <= 500),
  params jsonb not null default '{}'::jsonb,          -- country, language, namespace
  status text not null default 'pending'
    check (status in ('pending','sent','succeeded','failed','skipped')),
  http_status integer,
  error_kind text check (error_kind in ('auth','rate_limit','bad_request','server','network','timeout','parse','other')),
  error_text text check (error_text is null or length(error_text) <= 2000),
  retry_after timestamptz,
  attempt integer not null default 1 check (attempt between 1 and 5),
  result_count integer check (result_count >= 0),
  counted_against_budget boolean not null default false,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_queries_error_required
    check (status <> 'failed' or (error_kind is not null and error_text is not null))
);

create table public.discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  run_id uuid references public.discovery_runs(id),
  query_id uuid references public.discovery_queries(id),
  -- original, as found (immutable via trigger)
  provider_ref jsonb not null default '{}'::jsonb,
  found_url text check (found_url is null or length(found_url) <= 4000),
  found_title text check (found_title is null or length(found_title) <= 500),
  found_identifier text check (found_identifier is null or length(found_identifier) <= 300),
  found_at timestamptz not null default now(),
  -- working / confirmed
  country_code text check (country_code ~ '^[A-Z]{2}$'),
  language text check (language is null or length(language) <= 10),
  doc_type_guess text check (doc_type_guess is null or length(doc_type_guess) <= 80),
  relevance_note text check (relevance_note is null or length(relevance_note) <= 280),
  confirmed_title text,
  confirmed_identifier text,
  confirmed_source_url text,
  confidence jsonb not null default '{}'::jsonb,       -- {"title":"hypothesis|confirmed", ...}
  is_priority boolean not null default false,
  stage text not null default 'lead'
    check (stage in ('lead','identified','source_located','approved_for_collection','collected','reviewed_copy')),
  prefilled_stages text[] not null default '{}',
  outcome text not null default 'open'
    check (outcome in ('open','out_of_scope','rejected','duplicate')),
  outcome_reason text check (outcome_reason is null or length(outcome_reason) <= 500),
  retrieval_state text not null default 'none'
    check (retrieval_state in ('none','in_progress','access_failed','not_found','awaiting_retry')),
  same_as_candidate_id uuid references public.discovery_candidates(id),
  source_id uuid references public.sources(id),
  collection_job_id uuid references public.collection_jobs(id),
  raw_item_id uuid references public.raw_items(id),
  -- dedup keys (computed in app: canonicalized)
  key_provider text,
  key_identifier text,
  key_url text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_candidates_has_lead
    check (found_url is not null or found_title is not null or found_identifier is not null),
  constraint discovery_candidates_ref_no_text check (
    jsonb_typeof(provider_ref) = 'object'
    and not (provider_ref ?| array['text','full_text','snippet','snippets','excerpt','content','body','summary','highlight'])
  ),
  constraint discovery_candidates_outcome_reason
    check (outcome in ('open','duplicate') or outcome_reason is not null),
  constraint discovery_candidates_duplicate_link
    check (outcome <> 'duplicate' or same_as_candidate_id is not null),
  constraint discovery_candidates_not_self check (same_as_candidate_id <> id)
);

create table public.discovery_sightings (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.discovery_candidates(id),
  run_id uuid references public.discovery_runs(id),
  query_id uuid references public.discovery_queries(id),
  provider text not null,
  seen_url text check (seen_url is null or length(seen_url) <= 4000),
  seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- dedup + query indexes
create unique index discovery_candidates_key_provider_uq on public.discovery_candidates (key_provider) where key_provider is not null;
create unique index discovery_candidates_key_identifier_uq on public.discovery_candidates (key_identifier) where key_identifier is not null;
create unique index discovery_candidates_key_url_uq on public.discovery_candidates (key_url) where key_url is not null;
create index discovery_candidates_queue_idx on public.discovery_candidates (outcome, stage, country_code);
create index discovery_candidates_retrieval_idx on public.discovery_candidates (retrieval_state) where retrieval_state <> 'none';
create index discovery_candidates_run_idx on public.discovery_candidates (run_id);
create index discovery_queries_run_idx on public.discovery_queries (run_id);
create index discovery_queries_budget_idx on public.discovery_queries (sent_at) where counted_against_budget;
create index discovery_runs_provider_idx on public.discovery_runs (provider, started_at desc);
create unique index discovery_runs_one_running_per_provider on public.discovery_runs (provider) where status = 'running';
create index discovery_sightings_candidate_idx on public.discovery_sightings (candidate_id);

-- immutability of original lead fields
create or replace function public.discovery_candidates_protect_origin()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.provider is distinct from old.provider
     or new.provider_ref is distinct from old.provider_ref
     or new.found_url is distinct from old.found_url
     or new.found_title is distinct from old.found_title
     or new.found_identifier is distinct from old.found_identifier
     or new.found_at is distinct from old.found_at
     or new.run_id is distinct from old.run_id
     or new.query_id is distinct from old.query_id then
    raise exception 'discovery_candidates: original lead fields are immutable';
  end if;
  return new;
end $$;
revoke all on function public.discovery_candidates_protect_origin() from public, anon, authenticated;

create trigger discovery_candidates_protect_origin before update on public.discovery_candidates
  for each row execute function public.discovery_candidates_protect_origin();
create trigger set_updated_at before update on public.discovery_runs
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.discovery_queries
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.discovery_candidates
  for each row execute function public.set_updated_at();

-- deny by default (default ACL would otherwise grant Dxtm to anon/authenticated)
revoke all on public.discovery_runs, public.discovery_queries,
              public.discovery_candidates, public.discovery_sightings
  from public, anon, authenticated;
grant select, insert, update on public.discovery_runs, public.discovery_queries,
                               public.discovery_candidates to authenticated;
grant select, insert on public.discovery_sightings to authenticated;
grant all on public.discovery_runs, public.discovery_queries,
             public.discovery_candidates, public.discovery_sightings to service_role;

alter table public.discovery_runs enable row level security;
alter table public.discovery_queries enable row level security;
alter table public.discovery_candidates enable row level security;
alter table public.discovery_sightings enable row level security;

-- staff-only; no DELETE policy anywhere (denied)
create policy discovery_runs_staff_select on public.discovery_runs for select to authenticated using (public.is_staff(auth.uid()));
create policy discovery_runs_staff_insert on public.discovery_runs for insert to authenticated with check (public.is_staff(auth.uid()));
create policy discovery_runs_staff_update on public.discovery_runs for update to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));
create policy discovery_queries_staff_select on public.discovery_queries for select to authenticated using (public.is_staff(auth.uid()));
create policy discovery_queries_staff_insert on public.discovery_queries for insert to authenticated with check (public.is_staff(auth.uid()));
create policy discovery_queries_staff_update on public.discovery_queries for update to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));
create policy discovery_candidates_staff_select on public.discovery_candidates for select to authenticated using (public.is_staff(auth.uid()));
create policy discovery_candidates_staff_insert on public.discovery_candidates for insert to authenticated with check (public.is_staff(auth.uid()));
create policy discovery_candidates_staff_update on public.discovery_candidates for update to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));
create policy discovery_sightings_staff_select on public.discovery_sightings for select to authenticated using (public.is_staff(auth.uid()));
create policy discovery_sightings_staff_insert on public.discovery_sightings for insert to authenticated with check (public.is_staff(auth.uid()));
```

**Validation after apply.** Every check runs inside `begin; ... rollback;`, so nothing is kept.

1. **Privilege check:** `has_table_privilege` for anon and authenticated on all 4 tables. Expected:
   - anon has nothing, including TRUNCATE.
   - authenticated has only the granted privileges.
2. **`set local role anon`:** select is denied with a permission error.
3. **`set local role authenticated` as a non-staff user** (`request.jwt.claims` with a real non-staff uuid):
   - select returns 0 rows;
   - insert is refused by RLS.
4. **Same, as a real staff user's uuid:**
   - insert, update and select succeed;
   - delete is denied;
   - updating `found_url` raises the immutability error;
   - inserting `provider_ref` containing `snippet` is rejected;
   - inserting a second `running` run for the same provider is rejected.
5. **Advisors:** run the linter/advisors and report anything new.

**Concurrency guard.** The partial unique index allows only one `running` run per provider. Calls are reserved by a single conditional update on the run, made after counting `counted_against_budget` queries in the window. The app also sets runs whose heartbeat is older than 10 minutes to `interrupted` before starting a new run.

## 2. Revised design for 1B (no SQL yet; separate approval)

Four concepts mapped onto existing structures, without changing raw_items:

- **Document** (the norm being sought). New table `documents`: title, identifier, country, priority/mutable flags, last_checked_at, next_check_at, preferred extraction.
- **Copy** (the file from one source). A new `document_copies` link table connects document → raw_items row. It records:
  - origin class: official / secondary / unconfirmed — never inferred as official from a secondary host;
  - `file_sha256` of the original file;
  - `storage_path`.
- **Extraction** (text produced from a copy). Reuses raw_items itself, which already holds `content_hash` (text hash), `collector_version`, `collection_method` and `payload_integrity`. The link row adds `extraction_tool` / version when it differs. A better re-extraction of the same file is a new extraction of the same copy, not a new version of the norm.
- **Documentary version** (a genuinely different edition). An explicit `version_label` / `in_force_from` on the link row, set by staff. A hash change is first recorded as `change_detected` with its kind (file / extraction / unknown) until staff classify it.
- **Quality.** Append-only `copy_assessments`:
  - one grade: clean / defective / truncated / unreadable / unknown;
  - `extra_reasons text[]`;
  - `assessed_by_kind`: auto or staff;
  - confirmation by staff.

  "Clean" means only that technical checks passed.
- **Original files.** A new private bucket `original-files`: staff read/write via storage policies with `is_staff(auth.uid())`, no anon access, no public URLs, and service_role for collectors. The bucket is created with the bucket tool, not SQL.
- **Re-check.** A manual button per document, with defective, priority and mutable documents shown first.
  - Unchanged: only a check row plus `last_checked_at` is recorded.
  - Changed: a new raw_items row next to the old one, linked via the existing `supersedes_raw_item_id`.
  - The future cadence (30 / 90 / none days) is documented only and not activated.

## 3. Revised design for 1C (no SQL yet)

The internal catalog of reviewed copies equals a copy with a staff-confirmed `clean` assessment plus human approval. It is a status on the copy link, inside OryxScrape.

- Technical quality, origin class and approval are three separate fields.
- Non-clean copies stay readable in the working area.
- GET /feed is untouched. It keeps reading `normalized_items` eligible (+ promoted) and never reads the new tables. No new external API.
- **Conflict note.** Existing `normalized_items.publication_status='eligible'` is the feed's gate. Whether a reviewed copy should feed into `normalized_items` is a later, separate decision. Until then the two are independent.

## 4. Impact on Phases 2 and 3

- **Phase 2 UI:**
  - Rejected and out-of-scope candidates are hidden by default and can be shown with a filter, then reopened manually.
  - Sightings show "already rejected: reason".
  - Import fills in the known stages and records `prefilled_stages`.
  - Access failures appear as retrieval pending, never as rejected.
- **Phase 3 (LDH, separate approval).** Budget rules and requirements will be presented before activation:
  - rolling 24 h ≤ 20 calls, rolling 30 days ≤ 600, ≤ 10 per minute;
  - 15 priority calls first, then 5 for recovery or reformulation;
  - every call counted, provider headers read, and the run pauses and reports when the quota runs out;
  - 401 stops, 429 waits for Retry-After, 400 needs a fix, 500 gets a limited backoff;
  - the budget is LDH-specific, with no generic counter.

## 5. Constraints

- Cloudflare Workers runtime: short or chunked runs, so the heartbeat and interrupted recovery are needed.
- raw_items stays append-only.
- The /feed contract stays unchanged.
- The collection hierarchy stays unchanged.
- No pg_cron and no Edge Functions.

## 6. Open items needing approval

- **Phase 0:** revoke the stray TRUNCATE / TRIGGER / REFERENCES grants on existing tables.
- **Phase 1A:** the SQL above.
- **1B, 1C and LDH:** each needs its own approval later.
- **roadmap.md:** these phases will be added once building starts. Plan mode allows only this plan file to be edited.
