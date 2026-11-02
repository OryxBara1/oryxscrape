# Phase 1A: discovery queue (final SQL for review)

**Status**
- Phase 0 is applied (02 Nov 2026, migration `20261102064116_d5b3f344-a9c6-415e-8214-49eea9f34b9f.sql`) and verified.
- Phase 1A is not authorized. Nothing in this document has been applied.
- Phases 1B and 1C, LDH calls and scheduling are not authorized.
- OryxScrape stays independent, with no connection to any consumer product.

## Fixes in this revision

1. **Confidence check.** `public.discovery_confidence_is_valid(jsonb)` is now inside the script. It is created before `discovery_candidates`, and the CHECK constraint calls it. The script no longer has a subquery inside a CHECK.
2. **Helper EXECUTE rights.**
   - Postgres checks EXECUTE rights for a function used in a CHECK against the role doing the INSERT or UPDATE, not the table owner. The earlier claim that it is "evaluated by the table owner's rules" was wrong.
   - So the helper revokes EXECUTE only from `public` and `anon`, and explicitly grants it to `authenticated` and `service_role`.
   - Trigger functions keep their revokes. EXECUTE is not checked when a trigger fires.
3. **`key_provider` is now an ordinary nullable column, built by app code.**
   - The database checks its exact value: if it is present, it must equal `'prov:' || provider || ':' || lower(provider_source) || ':' || provider_source_id`.
   - In the conflict branch, all three keys stay null even when `provider_source` and `provider_source_id` are present.

I re-read the whole script for syntax and ordering:
- the helper is created before the table whose CHECK calls it;
- the tables are created in FK order: runs → queries → candidates → sightings;
- every constraint names existing columns;
- the trigger functions are created before their triggers;
- `set_updated_at` and `is_staff(uuid)` already exist;
- grants, then RLS, then policies;
- no CHECK contains a subquery.

This is a manual review. The script has not been executed.

## Dedup keys

App code builds all three keys from data we hold. The database checks their shape and uniqueness.

**`key_provider`**
- Format: `prov:<provider>:<lower(provider_source)>:<provider_source_id>`.
- It is only set when both source fields exist.
- The DB CHECK requires exact equality with that expression, so the provider is always part of the key.

**`key_identifier`**
- Format: `id:<COUNTRY>:<authority>:<normalized identifier>`.
- The DB checks the format, that COUNTRY equals `country_code`, and that authority equals `issuing_authority`.
- Normalization (app): Unicode NFKC, lowercase, whitespace collapsed, and dashes and slashes unified. The year and number are kept.
- It is only built when country, authority and identifier are all known with confidence.

**`key_url`**
- Format: `url:` followed by the canonical URL. `found_url` itself is always stored exactly as received.
- Canonical rules (app):
  - `http` and `https` both become `https`; any other scheme gives no key.
  - The host is lowercased and converted to punycode. A trailing dot is removed. `www.` is kept.
  - Default ports are removed.
  - The fragment is removed.
  - `utm_*`, `fbclid`, `gclid`, `mc_cid` and `mc_eid` are removed.
  - The remaining query parameters are sorted by name.
  - The path keeps its case. Repeated slashes are collapsed. A trailing slash is removed except on the root. Percent-encoding uses uppercase hex.
  - If the URL cannot be parsed, there is no key and `needs_review` is set.

**Ambiguous identifiers** (missing country or authority, or an authority guessed from a secondary site):
- `key_identifier` stays null;
- `needs_review = true`, with a `review_note` in our own words.

**Insert flow** (app code; every row gets an explicit result):
1. Look up existing candidates by each non-null key.
2. **One candidate matches on all present keys:** no new candidate. A sighting is inserted instead. Result: `sighting`, with the existing candidate id and which key matched.
3. **Different candidates match on different keys:** insert the new candidate with all three keys null, `needs_review = true`, and `review_note` listing the matched candidate ids. Result: `needs_review`.
4. **No match:** insert. Result: `inserted`.
5. **Unique violation (23505) on insert:** retry from step 1 once. If it still fails, the result is `error:key_conflict`. Rows are never dropped or merged silently.
6. **Invalid input:** result `invalid:<reason>`.

**Later human resolution** (staff, under the update policy):
- The key columns and `same_as_candidate_id` are working fields, not origin fields, so the guard trigger allows them to change.
- **Distinct document:** staff fill in the missing keys. If that collides, the database rejects it with 23505 and the UI shows the colliding candidate. Nothing is overwritten.
- **Same document:** staff set `same_as_candidate_id = <kept id>`, `outcome = 'duplicate'` and an `outcome_reason`, and leave the keys null.
  - The `found_*` fields, run, query and sightings stay intact.
  - The change is appended to `outcome_history`.
  - It can be reversed by setting `outcome` back to `open`.

**Collision tests** (vitest on the key builders in Phase 2, plus SQL checks after the migration):

| Case | Expected |
|---|---|
| IT `gazzetta_ufficiale` "Legge 123/2020" vs GR `et_gr` "Legge 123/2020" | Different `key_identifier`; both inserted |
| Same source and source_id under providers `ldh` and `manual` | Different `key_provider`; both inserted |
| IT "123/2020" under `gazzetta_ufficiale` vs under `normattiva` | Different keys; both inserted; linking them is a human decision |
| Identifier with no authority | `key_identifier` null, `needs_review`; inserted, not merged |
| `HTTP://Example.it:80/a//b/?utm_source=x#top` vs `https://example.it/a/b` | Same `key_url`; the second becomes a sighting |
| `…/doc?id=1` vs `…/doc?id=2` | Different `key_url` |
| Conflict branch: provider_source and provider_source_id present, all keys null, `needs_review` | Inserted; does not collide with the existing candidate |
| `key_provider` that does not match the expression (wrong provider, wrong case) | Rejected by CHECK |
| `key_identifier = 'id:GR:et_gr:…'` with `country_code = 'IT'` | Rejected by CHECK |
| `key_identifier = '123/2020'` (no prefix) | Rejected by CHECK |

## Guarantees: database vs app code

**Database (constraints, triggers, grants, RLS):**
- No jsonb column accepts provider data.
  - `confidence` is limited to whitelisted keys, each with the value `hypothesis` or `confirmed`.
  - `outcome_history` is written by the trigger only.
- Provider reference, query parameters and error codes are short strings checked against patterns.
- Every text column has a length limit.
- The original lead fields can't be changed.
- Sightings can only be added, never changed or deleted.
- Key shapes are checked:
  - `key_provider` must exactly equal its expression;
  - `key_identifier` must include country and authority, and both must match their columns;
  - `key_url` must carry its prefix.
- Keys are unique.
- Only one `running` run per provider at a time.
- Failed runs and failed queries must carry a classified error.
- Access is limited to staff and service_role; nobody can delete or empty the tables.

**App code only:**
- Building the keys follows the canonicalization rules above.
- The title, identifier, URL and type-guess values really are metadata, not snippets. The database only limits their length.
- `error_detail`, `relevance_note` and `review_note` use our own wording.
- Provider responses are reduced in memory to the allowed fields and are never logged.

## Phase 1A complete SQL (copy-ready, not applied)

```sql
-- =========================================================
-- Phase 1A: provider-agnostic discovery queue (4 tables)
-- Prerequisites (already exist): public.set_updated_at(), public.is_staff(uuid)
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

## Verification after execution

All checks run inside `begin; … rollback;`. A real TRUNCATE is never run. The Phase 0 privilege snapshot for the 13 existing tables must come out identical.

**1. Table privileges**

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
where c.relnamespace = 'public'::regnamespace
  and c.relname in ('discovery_runs','discovery_queries','discovery_candidates','discovery_sightings')
order by 1, 2;
```

Expected:
- `anon`: everything false.
- `authenticated` and `service_role`: sel, ins and upd true (sightings: sel and ins only); del, truncate, refs and trig false.

**2. Helper EXECUTE rights**

```sql
select r.rol,
       has_function_privilege(r.rol, 'public.discovery_confidence_is_valid(jsonb)', 'EXECUTE') as exec
from (values ('anon'), ('authenticated'), ('service_role')) as r(rol);
```

Expected: anon false; authenticated and service_role true.

**3. As anon:** any select fails with permission denied.

**4. As a non-staff user** (`authenticated` with real non-staff claims): selects return 0 rows, and inserts are refused by row-level security.

**5. As a real staff user** (`set local role authenticated` with staff claims):

- **Confidence check, run as authenticated:**
  - Inserting with `confidence = '{"title":"hypothesis","url":"confirmed"}'` succeeds, with no "permission denied for function".
  - `confidence = '{"snippet":"x"}'` is rejected.
  - `confidence = '{"title":"maybe"}'` is rejected.
- **Leads without an official URL:** a row with only `found_title` succeeds.
- **Collision rows:**
  - These pairs are both inserted:
    - IT `gazzetta_ufficiale` vs GR `et_gr` for the same number and year;
    - providers `ldh` vs `manual` with the same source and id;
    - IT `gazzetta_ufficiale` vs `normattiva` for the same identifier.
  - Inserting the same `key_url` twice gives 23505 on the second insert.
  - The conflict branch (provider_source and id present, all keys null, `needs_review`, `review_note` set) is inserted with no collision.
- **Key shape is rejected when wrong:**
  - `key_provider` that doesn't match the expression;
  - `key_identifier` whose country differs from `country_code`;
  - `key_identifier` without the prefix;
  - `needs_review` without a `review_note`.
- **Provider text:**
  - `provider_source` containing spaces or braces is rejected.
  - `param_namespace` containing spaces is rejected.
  - A failed query without `error_code` is rejected.
- **Original fields can't change:** updating `found_url` raises the immutability error.
- **Reopening a rejection:**
  - Rejecting with a reason, then setting `outcome = 'open'`, both succeed. The guard only freezes origin fields, and the staff update policy allows it.
  - `outcome_history` then has 2 entries.
  - Writing `outcome_history` directly gets overwritten.
- **Human merge:** setting `same_as_candidate_id`, `outcome = 'duplicate'` and a reason succeeds. The `found_*` fields and sightings are unchanged, and a history entry is added.
- **Access failure:** setting `retrieval_state = 'access_failed'` leaves `outcome = 'open'` and keeps the stage.
- **Sightings:** inserting succeeds; updating or deleting raises an error.
- **Run lock and recovery:**
  - A second `running` run for the same provider is rejected.
  - Set `heartbeat_at` to 11 minutes ago, then run this update (as staff, through "Run now" or "Mark interrupted", or as service_role):
    ```sql
    update public.discovery_runs
       set status = 'interrupted', finished_at = now(),
           error_code = 'heartbeat_timeout',
           error_detail = 'No heartbeat for over 10 minutes'
     where provider = $1 and status = 'running'
       and heartbeat_at < now() - interval '10 minutes';
    ```
  - It succeeds, and a new `running` run can then be inserted.
- **Delete:** denied on all 4 tables.

**6. Advisors:** report new findings separately from the 4 that already existed (1 × mutable search_path, 3 × SECURITY DEFINER executable by signed-in users).

## Exposed schemas

Not verified, and not changed. This is not a blocker for Phase 1A, because the tables are in `public` and protected by grants and row-level security, which the checks above prove.

Owner check: Dashboard → Project Settings → Data API → "Exposed schemas" should list `public` (and `graphql_public`) and nothing unexpected.

## Not authorized and unchanged

- Phases 1B and 1C, LDH, scheduling, and changes to default privileges.
- Existing tables, the /feed contract, the collection hierarchy, and the rule that raw items are never changed.
