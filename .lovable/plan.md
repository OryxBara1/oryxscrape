# Phase 1A (discovery queue): corrected final SQL for review

Status:
- **Phase 0:** applied on 02 Nov 2026 as migration `20261102064116_d5b3f344-a9c6-415e-8214-49eea9f34b9f.sql` and verified.
- **Phase 1A:** not authorized. Nothing in this document has been applied.
- **Phases 1B, 1C, LDH calls and scheduling:** not authorized.
- **Independence:** OryxScrape stays independent, with no connection to any consumer product.

## What changed in this revision

1. **Explicit privileges.** The script now revokes everything from `public`, `anon`, `authenticated` and `service_role` on the 4 new tables, then grants only what is intended.
   - This is needed because of the live default privileges in `public` (read earlier this session). New tables created by `postgres` give `Dxtm` (TRUNCATE, REFERENCES, TRIGGER) to anon, authenticated and service_role. Tables created by `supabase_admin` give `arwdDxtm` (everything) to all three.
   - The final privileges no longer depend on which role creates the tables.
   - Existing tables are not touched.
2. **Dedup keys.**
   - `key_provider` is a generated column, so the database builds it.
   - `key_identifier` and `key_url` have a fixed, prefixed format that the database checks.
   - Ambiguous identifiers are never merged. The key stays null and the row is flagged for human review.
   - Key conflicts always produce an explicit per-row result.
3. **No provider text.**
   - The `provider_ref` jsonb is replaced by two short, pattern-checked columns.
   - The `params` jsonb is replaced by three short, pattern-checked columns.
   - The `provider_quota` jsonb is replaced by integer columns.
   - Free-form error text is removed from queries. Errors are stored as `error_kind`, `http_status` and our own `error_code`. Runs keep a short `error_detail` written by our code only.

## Dedup key composition

All keys are built only from data we hold. Nothing comes from provider body text.

**`key_provider`** is a GENERATED column, built by the database.
- Format: `prov:` + provider + `:` + lower(provider_source) + `:` + provider_source_id.
- It is null unless both provider_source and provider_source_id are present.
- The provider is always part of the key, so the same `source_id` from two different providers cannot collide.

**`key_identifier`** is built by app code. The database checks its format.
- Format: `id:` + COUNTRY + `:` + authority + `:` + normalized identifier.
  - COUNTRY: two uppercase letters; must equal `country_code`.
  - authority: a slug of the issuing authority or official source, such as `gazzetta_ufficiale`, `et_gr`, `eur_lex`. Pattern `[a-z0-9_.-]{2,60}`.
  - normalized identifier: Unicode NFKC, lowercase, whitespace collapsed to a single space, and typographic dashes and slashes unified to `-` and `/`. The text is otherwise kept, including the year and the number.
- It is built only when country, authority and identifier are all known with confidence (`confidence.identifier = 'confirmed'`, or the importer supplies all three explicitly).
- **Ambiguous cases**, such as an identifier with no known country or authority, or an authority guessed from a secondary site:
  - `key_identifier` stays NULL;
  - `needs_review = true` and `review_note` gets our own wording, for example "identifier without issuing authority".
  - The candidate is still inserted, matched only by provider or URL, and is never merged automatically.

**`key_url`** is built by app code. The database checks its format.
- Format: `url:` + the canonical URL.
- `found_url` itself is always stored exactly as received.
- Canonicalization:
  1. Parse the URL. If it cannot be parsed, `key_url` stays null and `needs_review` is set.
  2. Scheme `http` or `https` becomes `https`; any other scheme gives no key.
  3. Host is lowercased and converted to punycode. A trailing dot is removed. A leading `www.` is kept, because some official sites serve different content there.
  4. Default ports (`:80`, `:443`) are removed.
  5. The fragment (`#…`) is removed.
  6. Tracking parameters are removed: `utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`.
  7. Remaining query parameters keep their value, are sorted by name, and empty values are kept.
  8. The path keeps its case. Repeated slashes are collapsed. A trailing slash is removed except on the root. Percent-encoding is normalized to uppercase hex.

**Applying the keys on insert.** App code handles each row like this. The database guarantees that no two candidates share a key.

1. Look up existing candidates by each non-null key.
2. **One candidate matches:** no new candidate is created. A `discovery_sightings` row is inserted instead. Result: `sighting`, plus the existing candidate's id and the key that matched.
3. **Different candidates match on different keys:** this is a possible conflict. A new candidate is inserted with all three keys null, `needs_review = true`, and a `review_note` listing the matched ids. Result: `needs_review`.
4. **No match:** insert the new candidate.
5. **Race:** if the insert hits a unique violation (23505), go back to step 1 once. If it fails again, the result is `error:key_conflict`. A conflict never silently drops a row and never silently merges two documents.
6. **Every import row gets an explicit result:** `inserted`, `sighting`, `needs_review` or `invalid:<reason>`.

**Collision tests** (vitest on the key builders in Phase 2, plus SQL checks after the migration):

| Case | Input | Expected |
|---|---|---|
| Same number and year, different countries | IT `gazzetta_ufficiale` "Legge 123/2020" vs GR `et_gr` "Legge 123/2020" | Two different `key_identifier` values; both inserted |
| Same ID, different providers | provider `ldh` source `x` id `42` vs provider `manual` source `x` id `42` | Two different `key_provider` values; both inserted |
| Same identifier, different authorities in the same country | IT `gazzetta_ufficiale` "123/2020" vs IT `normattiva` "123/2020" | Two different keys; both inserted. Linking them later via `same_as_candidate_id` is a human decision |
| Identifier without authority | country IT, identifier "123/2020", no authority | `key_identifier` null, `needs_review` true; inserted, not merged |
| Same URL, cosmetic differences | `HTTP://Example.it:80/a//b/?utm_source=x#top` vs `https://example.it/a/b` | Same `key_url`, so the second one becomes a sighting |
| Same URL with a different meaningful query | `…/doc?id=1` vs `…/doc?id=2` | Different `key_url` |
| Malformed `key_identifier` written directly | `key_identifier = '123/2020'` | Rejected by the CHECK constraint |
| `key_identifier` country differs from `country_code` | key `id:GR:…` with `country_code = 'IT'` | Rejected by the CHECK constraint |

## What the database guarantees vs what only app code guarantees

**Guaranteed by the database** (constraints, triggers, grants, RLS):
- No column can hold a provider's raw JSON response, raw request parameters or provider error body. No jsonb column accepts provider data.
  - `provider_source`, `provider_source_id`, the `param_*` columns and `error_code` are short, pattern-checked strings.
  - The only jsonb columns are `confidence`, where keys and values are restricted to a whitelist, and `outcome_history`, which only the trigger writes.
- Length limits on every text column.
- The original lead fields are immutable, and `outcome_history` is append-only and written by the trigger only.
- Sightings are append-only.
- `key_provider` always includes the provider.
- `key_identifier` always includes country plus authority, and its country matches `country_code`. `key_url` always carries its prefix.
- No two candidates share a key.
- Only one `running` run per provider at a time.
- Every failed run or failed query carries a classified error.
- Access is limited to staff (authenticated users who pass `is_staff(auth.uid())`) and service_role. No role can DELETE or TRUNCATE.

**Guaranteed only by app code** (reviewed in Phases 2 and 3, with tests):
- The values written into `found_title`, `found_identifier`, `found_url` and `doc_type_guess` really are metadata (a title, an identifier, a link) and not a pasted snippet. The database only limits their length: 500 characters for a title, 300 for an identifier.
- `error_detail` on runs is our own wording, never a provider body. The database limits it to 300 characters.
- `relevance_note` and `review_note` are written by staff or by our code in our own words.
- Key building follows the canonicalization rules above, and the database checks the shape.
- Provider responses are reduced in memory to the allowed fields before anything is written, and are never logged.

## Phase 1A complete SQL (corrected, not applied)

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
  -- dedup keys
  key_provider text generated always as (
    case when provider_source is not null and provider_source_id is not null
         then 'prov:' || provider || ':' || lower(provider_source) || ':' || provider_source_id
    end
  ) stored,
  key_identifier text check (key_identifier is null or (
    length(key_identifier) <= 400
    and key_identifier ~ '^id:[A-Z]{2}:[a-z0-9_.-]{2,60}:.+$'
  )),
  key_url text check (key_url is null or (
    length(key_url) <= 4004
    and key_url ~ '^url:https://[^/?#[:space:]]+'
  )),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_candidates_has_lead
    check (found_url is not null or found_title is not null or found_identifier is not null),
  constraint discovery_candidates_provider_ref_pair
    check ((provider_source is null) = (provider_source_id is null)),
  constraint discovery_candidates_key_identifier_context
    check (key_identifier is null or (
      country_code is not null
      and issuing_authority is not null
      and split_part(key_identifier, ':', 2) = country_code
      and split_part(key_identifier, ':', 3) = issuing_authority
    )),
  constraint discovery_candidates_confidence_shape check (
    jsonb_typeof(confidence) = 'object'
    and not exists (
      select 1 from jsonb_each(confidence) e
      where e.key not in ('title','identifier','url','country','authority','language','doc_type')
         or jsonb_typeof(e.value) <> 'string'
         or e.value #>> '{}' not in ('hypothesis','confirmed')
    )
  ),
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

Note on `confidence`: a CHECK constraint cannot contain a subquery, so the `exists (select … jsonb_each …)` form above is not valid in Postgres. In the final artifact this is moved into an IMMUTABLE helper, `public.discovery_confidence_is_valid(jsonb)`: SQL language, `set search_path = ''`, not SECURITY DEFINER, with EXECUTE revoked from public, anon and authenticated. The constraint then becomes `check (public.discovery_confidence_is_valid(confidence))`. The full helper text:

```sql
create or replace function public.discovery_confidence_is_valid(c jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(c) = 'object'
     and not exists (
       select 1 from jsonb_each(c) e
       where e.key not in ('title','identifier','url','country','authority','language','doc_type')
          or jsonb_typeof(e.value) <> 'string'
          or (e.value #>> '{}') not in ('hypothesis','confirmed')
     );
$$;
revoke all on function public.discovery_confidence_is_valid(jsonb) from public, anon, authenticated;
```

In the migration, this function is created before `discovery_candidates`. The table's constraint reads:

```sql
  constraint discovery_candidates_confidence_shape
    check (public.discovery_confidence_is_valid(confidence)),
```

The constraint is evaluated during table writes by the table owner's rules, so revoking EXECUTE from client roles does not block inserts.

## Verification after execution

All checks run inside `begin; … rollback;`. A real TRUNCATE is never run. Existing tables are not touched; to confirm, re-run the Phase 0 privilege snapshot for the 13 existing tables and expect it to be identical.

**1. Effective privileges on the 4 new tables:**

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
- **anon:** everything false.
- **authenticated and service_role:** sel, ins and upd true (sightings: sel and ins only); del, truncate, refs and trig false.

**2. As anon** (`set local role anon`): any select fails with "permission denied".

**3. As a non-staff signed-in user** (`set local role authenticated`, with `request.jwt.claims` set to a real non-staff uuid):
- select returns 0 rows;
- insert is refused by RLS.

**4. As a real staff user** (same claims with a staff uuid):
- **Leads without an official URL are accepted:** inserting a candidate with only `found_title` succeeds.
- **Collision rows:**
  - IT and GR "123/2020" with authorities `gazzetta_ufficiale` and `et_gr`: both inserted.
  - Same `provider_source` and `provider_source_id` under providers `ldh` and `manual`: both inserted.
  - IT "123/2020" under `gazzetta_ufficiale` and under `normattiva`: both inserted.
  - Inserting the same `key_url` twice: the second fails with 23505, which the app turns into a sighting.
  - `key_identifier = 'id:GR:et_gr:123/2020'` with `country_code = 'IT'`: rejected.
  - `key_identifier = '123/2020'`: rejected.
  - `needs_review = true` without a `review_note`: rejected.
- **Provider text cannot be stored:**
  - `provider_source = 'a b {json}'`: rejected.
  - `confidence = '{"snippet":"..."}'`: rejected.
  - `param_namespace` containing spaces: rejected.
  - A failed query without `error_code`: rejected.
- **Original fields are immutable:** updating `found_url` raises the immutability error.
- **Rejected items can be reopened:**
  - Reject with a reason: succeeds.
  - Reopen by setting `outcome = 'open'`: succeeds, because the guard trigger only freezes the lead fields and the staff update policy allows the change.
  - `outcome_history` then has 2 entries.
  - Writing `outcome_history` directly is overwritten by the trigger.
- **Access failures are not rejections:** setting `retrieval_state = 'access_failed'` leaves `outcome = 'open'` and keeps the stage.
- **Re-sightings:**
  - Inserting a sighting succeeds.
  - Updating or deleting it raises an error.
  - Candidates are unchanged.
- **One-running-run lock and stale-run recovery:**
  - A second `running` run for the same provider is rejected.
  - Set `heartbeat_at` 11 minutes into the past, then run the recovery update below. It is executed as staff by the "Run now" or "Mark interrupted" server function under the staff update policy, or by service_role for internal processes.
    ```sql
    update public.discovery_runs
       set status = 'interrupted', finished_at = now(),
           error_code = 'heartbeat_timeout',
           error_detail = 'No heartbeat for over 10 minutes'
     where provider = $1 and status = 'running'
       and heartbeat_at < now() - interval '10 minutes';
    ```
  - The update succeeds, and a new `running` run can then be inserted, so the lock is released.
- **No deletes:** delete on any of the 4 tables is denied.

**5. Advisors:** run the Supabase advisors and linter. Report new findings separately from the 4 that already existed (1 × mutable search_path, 3 × SECURITY DEFINER executable by signed-in users).

## Exposed schemas

Not verified by the owner, and not changed. This is not a blocker for Phase 1A, because the tables live in `public` and are protected by grants and RLS, which the checks above prove directly.

Recommended owner check: Dashboard → Project Settings → Data API → "Exposed schemas". It should list `public` (and `graphql_public`) and nothing unexpected.

## Not authorized and unchanged

- Phases 1B and 1C, the LDH integration, scheduling and default-privilege changes.
- Existing tables, the /feed contract, the collection hierarchy and raw_items immutability.
