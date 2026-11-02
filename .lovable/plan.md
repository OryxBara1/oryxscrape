# Discovery Candidates Queue + LDH Discovery Job

LDH is a discovery index only: metadata + official link. Candidates never become data until a human approves them, and they then go through the existing collection chain (official API → Parallel → Apify/Webshare → recordBlockedItem). Three phases, each approved separately; Phase 1 is the only schema change.

## Phase 1 — Migration only

New migration (applied via the project migration tool, no code in the same step).

```sql
-- runs first (FK target)
create table public.discovery_runs (
  id uuid primary key default gen_random_uuid(),
  method text not null check (method in ('ldh','parallel_search','manual','other')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  queries jsonb not null default '[]'::jsonb,      -- query strings sent only
  credits_used integer not null default 0 check (credits_used >= 0),
  candidates_found integer not null default 0,
  candidates_new integer not null default 0,
  status text not null default 'running'
    check (status in ('running','succeeded','failed','budget_exhausted')),
  error_text text,
  triggered_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_runs_error_required
    check (status not in ('failed','budget_exhausted') or error_text is not null)
);

create table public.discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  discovered_at timestamptz not null default now(),
  discovery_method text not null check (discovery_method in ('ldh','parallel_search','manual','other')),
  discovery_run_id uuid references public.discovery_runs(id),
  country_code text check (country_code ~ '^[A-Z]{2}$'),
  title text check (title is null or length(title) <= 500),
  official_url text not null check (length(btrim(official_url)) > 0),
  external_ref jsonb not null default '{}'::jsonb,  -- {provider, source, source_id} only
  language text,
  doc_type_guess text,
  relevance_note text check (relevance_note is null or length(relevance_note) <= 280),
  status text not null default 'new'
    check (status in ('new','approved_for_collection','collected','rejected','duplicate')),
  duplicate_of_raw_item_id uuid references public.raw_items(id),
  source_id uuid references public.sources(id),
  collection_job_id uuid references public.collection_jobs(id),
  dedup_key text not null unique,                  -- sha256 of canonicalized official_url
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_candidates_external_ref_shape check (
    jsonb_typeof(external_ref) = 'object'
    and not (external_ref ?| array['text','full_text','snippet','excerpt','content','body','summary'])
  ),
  constraint discovery_candidates_review_stamp
    check (status in ('new','duplicate') or reviewed_at is not null)
);

create index on public.discovery_candidates (status, country_code);
create index on public.discovery_candidates (discovery_run_id);
create index on public.discovery_candidates (discovered_at desc);
create index on public.discovery_runs (method, started_at desc);

-- deny by default
revoke all on public.discovery_runs, public.discovery_candidates from public, anon, authenticated;
grant select, insert, update on public.discovery_runs, public.discovery_candidates to authenticated;
grant all on public.discovery_runs, public.discovery_candidates to service_role;
alter table public.discovery_runs enable row level security;
alter table public.discovery_candidates enable row level security;

-- staff-only, same pattern as existing tables; no DELETE policy (denied)
create policy discovery_runs_staff_select on public.discovery_runs
  for select to authenticated using (public.is_staff(auth.uid()));
create policy discovery_runs_staff_insert on public.discovery_runs
  for insert to authenticated with check (public.is_staff(auth.uid()));
create policy discovery_runs_staff_update on public.discovery_runs
  for update to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));
-- identical three policies for discovery_candidates

create trigger set_updated_at before update on public.discovery_runs
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.discovery_candidates
  for each row execute function public.set_updated_at();
```

Notes:
- No new SECURITY DEFINER functions. Reuses existing `is_staff` (already definer with locked search_path). Step 0 confirms which signature is live (`is_staff()` vs `is_staff(uuid)`) and uses that one.
- Dedup against raw_items is done in app code at insert time (match canonicalized URL against `raw_items.source_url` / `canonical_url`, then insert with `status='duplicate'` + `duplicate_of_raw_item_id`). No trigger, so raw_items stays untouched and no definer is needed.
- The `external_ref` CHECK is a backstop against storing LDH text; the code whitelists fields anyway.

Validation (read-only after apply):
- `begin; set local role anon; select … from discovery_candidates;` → permission denied. Rollback.
- `begin; set local role authenticated; set local request.jwt.claims = '{"sub":"<non-staff uuid>","role":"authenticated"}';` → select returns 0 rows, insert fails RLS. Rollback.
- Same with a real staff user's uuid → select/insert/update succeed, delete denied. Rollback (nothing kept).
- Check constraints: insert with empty URL, `external_ref` containing `snippet`, status `approved_for_collection` without `reviewed_at` → all rejected.
- Run Supabase advisors/linter; report anything new.

## Phase 2 — Admin UI (`/admin/discovery`)

Files:
- `src/routes/_authenticated/admin.discovery.tsx` — list with filters (country, status, method), checkboxes, Approve / Reject / Mark duplicate, bulk actions, link to run history, bulk import box (JSON or CSV: `official_url,title,country_code,language,doc_type_guess,relevance_note`).
- `src/lib/discovery.functions.ts` — server functions with `requireSupabaseAuth` + staff check: `listCandidates`, `reviewCandidates({ids, status})` (sets status, reviewed_by, reviewed_at; allowed transitions only from `new`), `importCandidates(rows)` (method `manual`, creates a `discovery_runs` row, per-row result: inserted / duplicate / invalid with reason — no silent drops).
- `src/lib/discovery-url.ts` — pure `canonicalizeUrl` + `dedupKey` (lowercase host, strip fragment/tracking params, trailing slash) + unit tests.
- Nav link in the authenticated layout.

Approve only sets status. No collection is triggered in this phase.

Verification: vitest for canonicalization/dedup + import parsing (invalid URL, duplicate within batch, duplicate of raw_items). Signed-in browser test is not possible here (external Supabase), so the owner checks the page manually.

## Phase 3 — LDH discovery job

Files:
- `src/lib/ldh.server.ts` — `searchLdh({country:[code], query, namespace})`: POST `https://legaldatahunter.com/v1/search`, `Authorization: Bearer ${process.env.LDH_API_KEY}` read inside the handler. Missing key → run row `failed`, `error_text='LDH_API_KEY not configured'`. Response mapped immediately to `{title, official_url, source, source_id, country}`; everything else dropped in memory, never logged. `get_document` / `include_full_text` never referenced. UK sent as `"UK"`.
- `src/lib/discovery-ldh.server.ts` — builds queries from `search_terms` (active lifecycle states, not in cooldown, native `language_code` per country), one call = 1 credit, budget guard.
- `discovery.functions.ts` — `runLdhDiscovery({countries?, maxQueries?})`, staff-only, called by the "Run now" button.

Budget guard:
- Daily cap default 15 (constant, owner can change), computed as `sum(credits_used)` of today's (UTC) `ldh` runs before each call.
- Cap reached → stop, status `budget_exhausted` with error_text.
- Throttle: max 10 calls/min (≥6 s between calls); one run is capped at ~8 calls so it stays inside the Worker request time.
- HTTP 429 → stop run, status `failed`, `error_text='LDH 429 rate limited'`, no retry. Any other non-2xx/network/parse error → `failed` with status code, never an empty success.
- `credits_used` persisted after every call (so a crash still records spend).
- `search_terms.attempt_count` / `last_run_at` updated; `useful_count` only incremented when a candidate is later approved (Phase 2 action).

Verification: vitest with mocked fetch — mapper drops snippet/text fields, missing key, 429, budget exhaustion, dedup to `duplicate`. One real "Run now" with 1–2 queries after the owner adds the key, then SQL check that candidates hold no text.

## Credit estimate

- Free tier 20/day; we cap at 15 → max ~15 queries/day, ~105/week.
- Initial pass: ~5 countries (GR, MT, IT, UK, EU) × ~3 terms = 15 credits → one full day.
- Phase 3 test: 1–2 credits.

## Risks / open questions

1. LDH response field names (which one is the official URL vs the LDH page URL) — I will confirm against their docs before coding Phase 3; if only an LDH URL is returned, the candidate is skipped and counted, not stored.
2. `namespace` values: which ones to use per country? Default proposal: leave empty unless you give a list.
3. Approved → collection link: this plan stops at status. Next step (separate approval) maps an approved candidate to a `sources` row and starts a job through the existing chain, filling `collection_job_id` and `collected`.
4. Should `rejected` candidates block rediscovery forever? Proposed: yes (unique dedup_key keeps them rejected).
5. Daily budget uses UTC days — confirm vs LDH's reset time.

## Technical decisions to record in AGENTS.md (when built)

- Discovery providers store metadata + official link only; candidates enter data only via human approval and the existing collection chain.
