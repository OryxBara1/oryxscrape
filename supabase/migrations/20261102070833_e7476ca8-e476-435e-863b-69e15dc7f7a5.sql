-- =========================================================
-- Phase 1A: provider-agnostic discovery queue (4 tables)
-- Prerequisites (already exist): public.set_updated_at(), public.is_staff()
-- =========================================================

-- ---------- 0. helper used by a CHECK constraint ----------
create or replace function public.discovery_confidence_is_valid(c jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select c is not null
     and jsonb_typeof(c) = 'object'
     and not exists (
       select 1 from jsonb_each(c) e
       where e.key not in ('title','identifier','url','country','authority','language','doc_type')
          or jsonb_typeof(e.value) <> 'string'
          or (e.value #>> '{}') not in ('hypothesis','confirmed')
     );
$$;
-- EXECUTE is checked for the role doing the INSERT/UPDATE, so keep it for authenticated/service_role
revoke all on function public.discovery_confidence_is_valid(jsonb) from public, anon;
grant execute on function public.discovery_confidence_is_valid(jsonb) to authenticated, service_role;

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
  quota_minute_remaining integer check (quota_minute_remaining >= 0),
  quota_window_remaining integer check (quota_window_remaining >= 0),
  quota_period_remaining integer check (quota_period_remaining >= 0),
  quota_reset_at timestamptz,
  error_code text check (error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  error_detail text check (error_detail is null or length(error_detail) <= 300),
  triggered_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_runs_error_required
    check (status in ('running','succeeded') or error_code is not null),
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
  param_country text check (param_country ~ '^[A-Z]{2}$'),
  param_language text check (param_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  param_namespace text check (param_namespace ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  status text not null default 'pending'
    check (status in ('pending','sent','succeeded','failed','skipped')),
  http_status integer check (http_status between 100 and 599),
  error_kind text
    check (error_kind in ('auth','rate_limit','bad_request','server','network','timeout','parse','config','other')),
  error_code text check (error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  retry_after timestamptz,
  attempt integer not null default 1 check (attempt between 1 and 5),
  result_count integer check (result_count >= 0),
  counted_against_budget boolean not null default false,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_queries_error_required
    check (status <> 'failed' or (error_kind is not null and error_code is not null))
);

-- ---------- 3. discovery_candidates ----------
create table public.discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  run_id uuid references public.discovery_runs(id),
  query_id uuid references public.discovery_queries(id),
  -- original lead, exactly as found (immutable via trigger)
  provider_source text check (provider_source ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  provider_source_id text check (provider_source_id ~ '^[A-Za-z0-9_.:/-]{1,200}$'),
  found_url text check (found_url is null or length(found_url) <= 4000),
  found_title text check (found_title is null or length(found_title) <= 500),
  found_identifier text check (found_identifier is null or length(found_identifier) <= 300),
  found_at timestamptz not null default now(),
  -- working / confirmed fields
  country_code text check (country_code ~ '^[A-Z]{2}$'),
  issuing_authority text check (issuing_authority ~ '^[a-z0-9_.-]{2,60}$'),
  language text check (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  doc_type_guess text check (doc_type_guess is null or length(doc_type_guess) <= 80),
  relevance_note text check (relevance_note is null or length(relevance_note) <= 280),
  confirmed_title text check (confirmed_title is null or length(confirmed_title) <= 500),
  confirmed_identifier text check (confirmed_identifier is null or length(confirmed_identifier) <= 300),
  confirmed_source_url text check (confirmed_source_url is null or length(confirmed_source_url) <= 4000),
  confidence jsonb not null default '{}'::jsonb,
  is_priority boolean not null default false,
  needs_review boolean not null default false,
  review_note text check (review_note is null or length(review_note) <= 500),
  stage text not null default 'lead'
    check (stage in ('lead','identified','source_located','approved_for_collection','collected','reviewed_copy')),
  prefilled_stages text[] not null default '{}',
  outcome text not null default 'open'
    check (outcome in ('open','out_of_scope','rejected','duplicate')),
  outcome_reason text check (outcome_reason is null or length(outcome_reason) <= 500),
  outcome_history jsonb not null default '[]'::jsonb,  -- written by trigger only
  retrieval_state text not null default 'none'
    check (retrieval_state in ('none','in_progress','access_failed','not_found','awaiting_retry')),
  same_as_candidate_id uuid references public.discovery_candidates(id),
  source_id uuid references public.sources(id),
  collection_job_id uuid references public.collection_jobs(id),
  raw_item_id uuid references public.raw_items(id),
  -- dedup keys (built by app code; shape checked here)
  key_provider text,
  key_identifier text,
  key_url text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_candidates_has_lead
    check (found_url is not null or found_title is not null or found_identifier is not null),
  constraint discovery_candidates_provider_ref_pair
    check ((provider_source is null) = (provider_source_id is null)),
  constraint discovery_candidates_key_provider_shape
    check (key_provider is null or (
      provider_source is not null
      and key_provider = 'prov:' || provider || ':' || lower(provider_source) || ':' || provider_source_id
    )),
  constraint discovery_candidates_key_identifier_shape
    check (key_identifier is null or (
      length(key_identifier) <= 400
      and key_identifier ~ '^id:[A-Z]{2}:[a-z0-9_.-]{2,60}:.+$'
      and country_code is not null
      and issuing_authority is not null
      and split_part(key_identifier, ':', 2) = country_code
      and split_part(key_identifier, ':', 3) = issuing_authority
    )),
  constraint discovery_candidates_key_url_shape
    check (key_url is null or (
      length(key_url) <= 4004
      and key_url ~ '^url:https://[^/?#[:space:]]+'
    )),
  constraint discovery_candidates_confidence_shape
    check (public.discovery_confidence_is_valid(confidence)),
  constraint discovery_candidates_outcome_reason
    check (outcome in ('open','duplicate') or outcome_reason is not null),
  constraint discovery_candidates_duplicate_link
    check (outcome <> 'duplicate' or same_as_candidate_id is not null),
  constraint discovery_candidates_not_self
    check (same_as_candidate_id is null or same_as_candidate_id <> id),
  constraint discovery_candidates_prefilled_valid
    check (prefilled_stages <@ array['lead','identified','source_located','approved_for_collection','collected','reviewed_copy']::text[]),
  constraint discovery_candidates_review_note_required
    check (not needs_review or review_note is not null)
);

-- ---------- 4. discovery_sightings (append-only) ----------
create table public.discovery_sightings (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.discovery_candidates(id),
  run_id uuid references public.discovery_runs(id),
  query_id uuid references public.discovery_queries(id),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  matched_key text not null check (matched_key in ('provider','identifier','url')),
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
create index discovery_candidates_review_idx
  on public.discovery_candidates (needs_review) where needs_review;
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
  if new.provider              is distinct from old.provider
     or new.provider_source    is distinct from old.provider_source
     or new.provider_source_id is distinct from old.provider_source_id
     or new.found_url          is distinct from old.found_url
     or new.found_title        is distinct from old.found_title
     or new.found_identifier   is distinct from old.found_identifier
     or new.found_at           is distinct from old.found_at
     or new.run_id             is distinct from old.run_id
     or new.query_id           is distinct from old.query_id
     or new.created_at         is distinct from old.created_at then
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

-- trigger functions are not EXECUTE-checked when they fire
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

-- ---------- grants: explicit, independent of default privileges ----------
revoke all on public.discovery_runs, public.discovery_queries,
              public.discovery_candidates, public.discovery_sightings
  from public, anon, authenticated, service_role;

grant select, insert, update on public.discovery_runs       to authenticated, service_role;
grant select, insert, update on public.discovery_queries    to authenticated, service_role;
grant select, insert, update on public.discovery_candidates to authenticated, service_role;
grant select, insert         on public.discovery_sightings  to authenticated, service_role;

-- ---------- RLS ----------
alter table public.discovery_runs enable row level security;
alter table public.discovery_queries enable row level security;
alter table public.discovery_candidates enable row level security;
alter table public.discovery_sightings enable row level security;

-- ---------- policies (staff only; no DELETE policy anywhere) ----------
create policy discovery_runs_staff_select on public.discovery_runs
  for select to authenticated using (public.is_staff());
create policy discovery_runs_staff_insert on public.discovery_runs
  for insert to authenticated with check (public.is_staff());
create policy discovery_runs_staff_update on public.discovery_runs
  for update to authenticated using (public.is_staff()) with check (public.is_staff());

create policy discovery_queries_staff_select on public.discovery_queries
  for select to authenticated using (public.is_staff());
create policy discovery_queries_staff_insert on public.discovery_queries
  for insert to authenticated with check (public.is_staff());
create policy discovery_queries_staff_update on public.discovery_queries
  for update to authenticated using (public.is_staff()) with check (public.is_staff());

create policy discovery_candidates_staff_select on public.discovery_candidates
  for select to authenticated using (public.is_staff());
create policy discovery_candidates_staff_insert on public.discovery_candidates
  for insert to authenticated with check (public.is_staff());
create policy discovery_candidates_staff_update on public.discovery_candidates
  for update to authenticated using (public.is_staff()) with check (public.is_staff());

create policy discovery_sightings_staff_select on public.discovery_sightings
  for select to authenticated using (public.is_staff());
create policy discovery_sightings_staff_insert on public.discovery_sightings
  for insert to authenticated with check (public.is_staff());