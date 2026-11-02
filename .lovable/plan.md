# Phase 0 (TRUNCATE fix) and Phase 1A (discovery queue): final SQL for review

Nothing here has been applied. Phase 0 and Phase 1A each need a separate approval to run. Phases 1B and 1C, LDH calls and any scheduling are not authorized. OryxScrape stays independent, with no connection to any consumer product.

---

## Phase 0: revoke TRUNCATE only

### Live re-check (read-only, 02 Nov 2026)

I checked effective privileges with `has_table_privilege` and read each table's ACL.

- **anon holds TRUNCATE on 4 tables:** exchange_handoffs, exchange_suppressions, search_terms, staff_members. The earlier count missed the two exchange tables.
- **authenticated holds TRUNCATE on all 13 public tables:** audit_events, collection_jobs, consumer_keys, exchange_handoffs, exchange_suppressions, normalized_item_profile_exposure, normalized_items, raw_items, research_profile_tier_policies, research_profiles, search_terms, sources, staff_members.
- **PUBLIC** has no entry on any of these ACLs. It is included in the REVOKE anyway; this is a harmless no-op.
- **Cause:** the schema's default privileges give anon and authenticated `Dxtm` (TRUNCATE, REFERENCES, TRIGGER) on every new table created by `postgres`. Changing those defaults is not in Phase 0. Phase 1A revokes explicitly on its own tables instead.

### SQL

```sql
-- Phase 0: revoke TRUNCATE only. No data, RLS, policy, or other privilege change.
revoke truncate on table
  public.audit_events,
  public.collection_jobs,
  public.consumer_keys,
  public.exchange_handoffs,
  public.exchange_suppressions,
  public.normalized_item_profile_exposure,
  public.normalized_items,
  public.raw_items,
  public.research_profile_tier_policies,
  public.research_profiles,
  public.search_terms,
  public.sources,
  public.staff_members
from public, anon, authenticated;
```

service_role and postgres are not named, so nothing changes for internal processes. No app code uses TRUNCATE, and the Data API cannot issue it.

### TRIGGER and REFERENCES: left out

- **TRIGGER:** left out. Using it needs DDL, which the Data API cannot run. It is not the minimum fix, so it can get its own small migration later.
- **REFERENCES:** left out. Using it needs CREATE TABLE rights in some schema to add a foreign key. Low risk, and handling it now would widen scope silently.

### Verification after execution

This only reads privileges. A real TRUNCATE is never run. Effective privileges include inherited and PUBLIC grants.

Run this same query before and after execution and diff the two results. Only `truncate` should change, to `false` for both roles. Every other column must be identical.

```sql
select c.relname as table_name, r.rol as role,
       has_table_privilege(r.rol, c.oid, 'SELECT')     as sel,
       has_table_privilege(r.rol, c.oid, 'INSERT')     as ins,
       has_table_privilege(r.rol, c.oid, 'UPDATE')     as upd,
       has_table_privilege(r.rol, c.oid, 'DELETE')     as del,
       has_table_privilege(r.rol, c.oid, 'TRUNCATE')   as truncate,
       has_table_privilege(r.rol, c.oid, 'REFERENCES') as refs,
       has_table_privilege(r.rol, c.oid, 'TRIGGER')    as trig
from pg_class c
cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')
order by 1, 2;
```

Expected result: `truncate = false` for anon and authenticated on all 13 tables, and service_role unchanged.

---

## Phase 1A: discovery queue, complete SQL

Scope:

- **4 tables:** discovery_runs, discovery_queries, discovery_candidates, discovery_sightings.
- **2 new trigger functions:** discovery_candidates_guard and discovery_sightings_append_only. Neither is SECURITY DEFINER.
- **Reused:** the existing `set_updated_at` and `is_staff(uuid)`.
- **Not touched:** existing tables.

```sql
-- =========================================================
-- Phase 1A: provider-agnostic discovery queue (4 tables)
-- =========================================================

-- ---------- 1. discovery_runs ----------
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
  provider_quota jsonb not null default '{}'::jsonb check (jsonb_typeof(provider_quota) = 'object'),
  error_text text check (error_text is null or length(error_text) <= 2000),
  triggered_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_runs_error_required
    check (status in ('running','succeeded') or error_text is not null),
  constraint discovery_runs_finished
    check ((status = 'running') = (finished_at is null))
);

-- ---------- 2. discovery_queries ----------
create table public.discovery_queries (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.discovery_runs(id),
  search_term_id uuid references public.search_terms(id),
  purpose text not null default 'new'
    check (purpose in ('new','recovery','reformulation','urgent')),
  query_text text not null
    check (length(btrim(query_text)) > 0 and length(query_text) <= 500),
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  status text not null default 'pending'
    check (status in ('pending','sent','succeeded','failed','skipped')),
  http_status integer,
  error_kind text
    check (error_kind in ('auth','rate_limit','bad_request','server','network','timeout','parse','other')),
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

-- ---------- 3. discovery_candidates ----------
create table public.discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  run_id uuid references public.discovery_runs(id),
  query_id uuid references public.discovery_queries(id),
  -- original lead, exactly as found (immutable via trigger)
  provider_ref jsonb not null default '{}'::jsonb,
  found_url text check (found_url is null or length(found_url) <= 4000),
  found_title text check (found_title is null or length(found_title) <= 500),
  found_identifier text check (found_identifier is null or length(found_identifier) <= 300),
  found_at timestamptz not null default now(),
  -- working / confirmed fields
  country_code text check (country_code ~ '^[A-Z]{2}$'),
  language text check (language is null or length(language) <= 10),
  doc_type_guess text check (doc_type_guess is null or length(doc_type_guess) <= 80),
  relevance_note text check (relevance_note is null or length(relevance_note) <= 280),
  confirmed_title text check (confirmed_title is null or length(confirmed_title) <= 500),
  confirmed_identifier text check (confirmed_identifier is null or length(confirmed_identifier) <= 300),
  confirmed_source_url text check (confirmed_source_url is null or length(confirmed_source_url) <= 4000),
  confidence jsonb not null default '{}'::jsonb check (jsonb_typeof(confidence) = 'object'),
  is_priority boolean not null default false,
  stage text not null default 'lead'
    check (stage in ('lead','identified','source_located','approved_for_collection','collected','reviewed_copy')),
  prefilled_stages text[] not null default '{}',
  outcome text not null default 'open'
    check (outcome in ('open','out_of_scope','rejected','duplicate')),
  outcome_reason text check (outcome_reason is null or length(outcome_reason) <= 500),
  outcome_history jsonb not null default '[]'::jsonb,  -- appended by trigger only
  retrieval_state text not null default 'none'
    check (retrieval_state in ('none','in_progress','access_failed','not_found','awaiting_retry')),
  same_as_candidate_id uuid references public.discovery_candidates(id),
  source_id uuid references public.sources(id),
  collection_job_id uuid references public.collection_jobs(id),
  raw_item_id uuid references public.raw_items(id),
  -- conservative dedup keys (canonicalized in app code)
  key_provider text check (key_provider is null or length(key_provider) <= 400),
  key_identifier text check (key_identifier is null or length(key_identifier) <= 400),
  key_url text check (key_url is null or length(key_url) <= 4000),
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
  constraint discovery_candidates_not_self
    check (same_as_candidate_id is null or same_as_candidate_id <> id),
  constraint discovery_candidates_prefilled_valid
    check (prefilled_stages <@ array['lead','identified','source_located','approved_for_collection','collected','reviewed_copy']::text[])
);

-- ---------- 4. discovery_sightings (append-only) ----------
create table public.discovery_sightings (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.discovery_candidates(id),
  run_id uuid references public.discovery_runs(id),
  query_id uuid references public.discovery_queries(id),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  seen_url text check (seen_url is null or length(seen_url) <= 4000),
  seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ---------- indexes ----------
create unique index discovery_candidates_key_provider_uq
  on public.discovery_candidates (key_provider) where key_provider is not null;
create unique index discovery_candidates_key_identifier_uq
  on public.discovery_candidates (key_identifier) where key_identifier is not null;
create unique index discovery_candidates_key_url_uq
  on public.discovery_candidates (key_url) where key_url is not null;
create index discovery_candidates_queue_idx
  on public.discovery_candidates (outcome, stage, country_code);
create index discovery_candidates_retrieval_idx
  on public.discovery_candidates (retrieval_state) where retrieval_state <> 'none';
create index discovery_candidates_run_idx on public.discovery_candidates (run_id);
create index discovery_candidates_same_as_idx
  on public.discovery_candidates (same_as_candidate_id) where same_as_candidate_id is not null;
create index discovery_queries_run_idx on public.discovery_queries (run_id);
create index discovery_queries_budget_idx
  on public.discovery_queries (sent_at) where counted_against_budget;
create index discovery_runs_provider_idx on public.discovery_runs (provider, started_at desc);
create unique index discovery_runs_one_running_per_provider
  on public.discovery_runs (provider) where status = 'running';
create index discovery_sightings_candidate_idx on public.discovery_sightings (candidate_id);
create index discovery_sightings_run_idx on public.discovery_sightings (run_id);

-- ---------- trigger functions (SECURITY INVOKER, locked search_path) ----------
create or replace function public.discovery_candidates_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.outcome_history := '[]'::jsonb;
    return new;
  end if;

  -- original lead fields never change
  if new.provider         is distinct from old.provider
     or new.provider_ref     is distinct from old.provider_ref
     or new.found_url        is distinct from old.found_url
     or new.found_title      is distinct from old.found_title
     or new.found_identifier is distinct from old.found_identifier
     or new.found_at         is distinct from old.found_at
     or new.run_id           is distinct from old.run_id
     or new.query_id         is distinct from old.query_id
     or new.created_at       is distinct from old.created_at then
    raise exception 'discovery_candidates: original lead fields are immutable';
  end if;

  -- history is append-only and written only here
  new.outcome_history := old.outcome_history;
  if new.outcome is distinct from old.outcome
     or new.outcome_reason is distinct from old.outcome_reason then
    new.outcome_history := old.outcome_history || jsonb_build_array(jsonb_build_object(
      'from', old.outcome,
      'from_reason', old.outcome_reason,
      'to', new.outcome,
      'to_reason', new.outcome_reason,
      'by', auth.uid(),
      'at', now()
    ));
  end if;
  return new;
end;
$$;

create or replace function public.discovery_sightings_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'discovery_sightings is append-only';
end;
$$;

revoke all on function public.discovery_candidates_guard() from public, anon, authenticated;
revoke all on function public.discovery_sightings_append_only() from public, anon, authenticated;

-- ---------- triggers ----------
create trigger discovery_candidates_guard
  before insert or update on public.discovery_candidates
  for each row execute function public.discovery_candidates_guard();
create trigger discovery_sightings_no_update_delete
  before update or delete on public.discovery_sightings
  for each row execute function public.discovery_sightings_append_only();
create trigger set_discovery_runs_updated_at
  before update on public.discovery_runs
  for each row execute function public.set_updated_at();
create trigger set_discovery_queries_updated_at
  before update on public.discovery_queries
  for each row execute function public.set_updated_at();
create trigger set_discovery_candidates_updated_at
  before update on public.discovery_candidates
  for each row execute function public.set_updated_at();

-- ---------- grants (deny by default; overrides default ACL Dxtm) ----------
revoke all on public.discovery_runs, public.discovery_queries,
              public.discovery_candidates, public.discovery_sightings
  from public, anon, authenticated;
grant select, insert, update on public.discovery_runs to authenticated;
grant select, insert, update on public.discovery_queries to authenticated;
grant select, insert, update on public.discovery_candidates to authenticated;
grant select, insert on public.discovery_sightings to authenticated;
grant select, insert, update on public.discovery_runs, public.discovery_queries,
                               public.discovery_candidates to service_role;
grant select, insert on public.discovery_sightings to service_role;

-- ---------- RLS ----------
alter table public.discovery_runs enable row level security;
alter table public.discovery_queries enable row level security;
alter table public.discovery_candidates enable row level security;
alter table public.discovery_sightings enable row level security;

-- ---------- policies (staff only; no DELETE policy anywhere) ----------
create policy discovery_runs_staff_select on public.discovery_runs
  for select to authenticated using (public.is_staff(auth.uid()));
create policy discovery_runs_staff_insert on public.discovery_runs
  for insert to authenticated with check (public.is_staff(auth.uid()));
create policy discovery_runs_staff_update on public.discovery_runs
  for update to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

create policy discovery_queries_staff_select on public.discovery_queries
  for select to authenticated using (public.is_staff(auth.uid()));
create policy discovery_queries_staff_insert on public.discovery_queries
  for insert to authenticated with check (public.is_staff(auth.uid()));
create policy discovery_queries_staff_update on public.discovery_queries
  for update to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

create policy discovery_candidates_staff_select on public.discovery_candidates
  for select to authenticated using (public.is_staff(auth.uid()));
create policy discovery_candidates_staff_insert on public.discovery_candidates
  for insert to authenticated with check (public.is_staff(auth.uid()));
create policy discovery_candidates_staff_update on public.discovery_candidates
  for update to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

create policy discovery_sightings_staff_select on public.discovery_sightings
  for select to authenticated using (public.is_staff(auth.uid()));
create policy discovery_sightings_staff_insert on public.discovery_sightings
  for insert to authenticated with check (public.is_staff(auth.uid()));
```

### Behaviour this SQL guarantees

- **Leads without an official URL are accepted.** `found_url` is nullable. `discovery_candidates_has_lead` only requires one of URL, title or identifier. No column requires an official URL; `confirmed_source_url` stays empty until it is confirmed.
- **Re-sightings keep the trail without creating duplicate tasks.**
  - The three partial unique indexes reject a second candidate with the same provider key, identifier or URL.
  - The app first looks for a match on any key. When it finds one, it inserts a `discovery_sightings` row (run, query, provider, URL seen, time) instead of a new candidate.
  - A rejected match is shown as "already rejected: reason" and is never reopened automatically.
  - Sightings can't be changed or deleted: a trigger blocks it, and there are no UPDATE or DELETE grants.
- **Access failures are not rejections.** They live in the separate `retrieval_state` (access_failed, not_found, awaiting_retry). `outcome` stays `open`, and `stage` keeps its identification progress.
- **Rejected items can be reopened manually.**
  - The guard trigger only freezes the original lead fields (provider, provider_ref, found_*, run_id, query_id, created_at). `outcome` and `outcome_reason` are mutable.
  - A staff user, allowed by `discovery_candidates_staff_update`, sets `outcome='open'`. `discovery_candidates_outcome_reason` allows a null reason for `open`.
  - The same trigger appends the previous outcome, reason, user and time to `outcome_history`, so the rejection is never lost. Users cannot edit that history; the trigger always rebuilds it from the old row.
- **The one-running-run lock can always be recovered.**
  - The partial unique index applies only to `status='running'`, so a run leaves the lock as soon as its status changes.
  - The Phase 3 "Run now" server function runs as the signed-in staff user with RLS applied. The staff update policy allows the following before it inserts a new run:
    ```sql
    update public.discovery_runs
       set status = 'interrupted', finished_at = now(),
           error_text = 'heartbeat timeout: no heartbeat for over 10 minutes'
     where provider = $1 and status = 'running'
       and heartbeat_at < now() - interval '10 minutes';
    ```
  - It satisfies both `discovery_runs_error_required` and `discovery_runs_finished`.
  - Staff also get a manual "Mark interrupted" button that runs the same update.
  - service_role, for later internal processes, can run it too because it bypasses RLS.
  - A live run refreshes `heartbeat_at` after every call, so it is never taken over by mistake.
- **Only staff and internal processes can reach the queue.**
  - `REVOKE ALL` removes the default `Dxtm` and any PUBLIC access.
  - anon gets nothing.
  - authenticated gets only SELECT/INSERT/UPDATE (sightings: SELECT/INSERT), and every policy requires `is_staff(auth.uid())`. Non-staff users see 0 rows and cannot write.
  - service_role gets the same set, without DELETE or TRUNCATE.
  - No table can be deleted from by any role except the owner.

### Verification after execution

Nothing is kept: every check runs inside `begin; … rollback;`. A real TRUNCATE is never run.

1. **Privileges.** Run the Phase 0 query with `c.relname like 'discovery_%'`. Expected:
   - anon: all false.
   - authenticated: sel/ins/upd true (sightings: sel/ins), del/truncate/refs/trig false.
   - service_role: same as authenticated.
2. **As anon:** `set local role anon; select 1 from public.discovery_candidates;` fails with permission denied.
3. **As a non-staff user:** `set local role authenticated; set local request.jwt.claims = '{"sub":"<non-staff uuid>","role":"authenticated"}';`. Select returns 0 rows, and insert is refused by RLS.
4. **As a real staff user** (same claims with a staff uuid):
   - insert a candidate with title only (no URL): succeeds;
   - change `found_url`: raises the immutability error;
   - reject with a reason, then reopen: `outcome_history` has 2 entries;
   - `provider_ref` containing `snippet`: rejected;
   - a second `running` run for the same provider: rejected;
   - the stale-run update above, after setting `heartbeat_at` into the past: succeeds and the lock is released;
   - update or delete on sightings: raises an error;
   - delete on any table: denied.
5. **Advisors.** Run the Supabase advisors and linter, then report anything new.

---

## Exposed schemas (not verified, not changed)

This is not a blocker for Phase 1A.

- The new tables live in `public`, which the app already depends on through the Data API.
- Their protection comes from grants and RLS, which the checks above prove directly in SQL.

Recommended owner check: Dashboard → Project Settings → Data API → "Exposed schemas". It should list `public` (and `graphql_public`) and no unexpected schema. This setting would matter only if a private schema were introduced later, which is not planned.

## Not authorized and unchanged

- Phases 1B and 1C, the LDH integration, scheduling and default-privilege changes.
- The /feed contract, the collection hierarchy and raw_items immutability.
- roadmap.md will be updated once building starts.
