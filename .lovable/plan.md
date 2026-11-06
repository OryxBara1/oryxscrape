# LDH discovery — thin slice (revised plan, NOT executed)

Status: planning only. Nothing runs until a separate Build message. Labels: [V] read in this session, [E] reported earlier, [N] not tested.

Terms note (stated once): LDH Free-plan terms effective 2026-08-11 leave an open question about this use; owner proceeds knowingly. This does not authorize bypassing auth, rate limits or access controls.

## 1. Files

- New `src/lib/ldh-discovery.server.ts` — LDH client, hit allowlist/validation, dedup, quota/reservation. Pure helpers exported for tests.
- New `src/lib/discovery.functions.ts` — `runLdhSearch` (POST) and `listDiscoveryCandidates` (GET, read-only).
- New `src/routes/_authenticated/discovery.tsx` — search form + read-only list.
- Edit `src/components/app-shell.tsx` — one nav entry "Discovery" → `/discovery` (nav array at lines 25-36 [V]).
- New `src/lib/ldh-discovery.server.test.ts` — mocked tests.
- Not touched: storage, originals, collection, scheduler, cron, schema, migrations, alerts, the 3 parked jobs.
- Types: `discovery_*` tables are present in `src/integrations/supabase/types.ts` (line 183+) [V]; an untyped handle is used only if a column is missing.

## 2. Server function

`runLdhSearch` — `.middleware([requireSupabaseAuth])` (same pattern as `search-terms.functions.ts` [V]), then `is_staff()` via `context.supabase` RPC; non-staff → `forbidden`, no LDH call. All writes as the user through RLS (staff insert/update policies exist [V]); no admin client.

Input (zod): `q` string 1-500 (DB limit `query_text <= 500` [V]; API allows 10000 [V]); `namespace` enum `legislation|case_law|doctrine`; `country` optional `^[A-Z]{2}$` (sent as 1-element array; DB stores one `param_country` [V]); `language` optional `^[a-z]{2,3}(-…)?$`; `date_start`/`date_end` optional YYYY-MM-DD.

Request body sent: `{ q, namespace, country?, language?, date_start?, date_end?, top_k: 10 }`. `result_detail` omitted (default "snippet" shape [V]); never `full_text`. Only `POST /v1/search` is ever called; never `/v1/documents/...` (the get-document endpoint) [V path list].

Output: `{ runId, status, httpStatus, hitsReturned, created, sighted, unusable: [{index, reason}], conflicts: [{index, keys, candidateIds}], quota: { used24h, used30d } , errorCode? }` — no provider text, no raw body.

## 3. Field mapping (DB constraints from migration 20261102070833 [V])

provider = `'ldh'` (matches `^[a-z][a-z0-9_]{1,31}$`).

| Hit field | Column | Constraint | Rule |
|---|---|---|---|
| source | provider_source | `^[A-Za-z0-9_.:-]{1,100}$`, both-or-neither with source_id | stored as-is; if invalid → both null |
| source_id | provider_source_id | `^[A-Za-z0-9_.:/-]{1,200}$` | as-is; if invalid → both null |
| (derived) | key_provider | must equal `'prov:ldh:'+lower(source)+':'+source_id` | set only when both valid |
| url | found_url | ≤4000 | stored byte-for-byte (no https upgrade, no slash/param changes) |
| url | key_url | `^url:https://[^/?#\s]+`, ≤4004 | `'url:'+url` only if url already starts with `https://`; else null |
| title | found_title | ≤500 | as-is if ≤500, else null + note in unusable reasons (not truncated) |
| identifier | found_identifier | ≤300 | as-is if ≤300, else null |
| country | country_code | `^[A-Z]{2}$` | as-is if matching, else null |
| authority | issuing_authority | `^[a-z0-9_.-]{2,60}$` | as-is if matching, else null (no slugifying) |
| language | language | `^[a-z]{2,3}(-…)?$` | as-is if matching, else null |
| document_type | doc_type_guess | ≤80 | as-is if fits, else null |
| (derived) | key_identifier | `id:CC:authority:identifier`, parts must equal columns | only if country, authority and identifier all valid as-is; else null |
| — | confidence | keys ⊂ title/identifier/url/country/authority/language/doc_type, values hypothesis/confirmed | `"hypothesis"` for every non-null stored field |
| — | stage/outcome/retrieval_state | defaults lead/open/none | defaults |
| — | run_id, query_id | FK | this run/query |

Never stored anywhere (DB, logs, error_detail): snippet, summary, text, score, raw body, headers, key. score/date/eli_uri/ecli are not stored (no column); eli_uri/ecli are not used as keys.

Unusable hit: row would fail `found_url or found_title or found_identifier not null`, or no valid key (key_provider, key_identifier, key_url all null) → not inserted, reported by index + reason code.

## 4. Dedup

Compute present keys (provider, identifier, url). Look up existing candidates by each key.
- None match → insert candidate (unique partial indexes on each key [V] catch races; a unique violation is re-resolved once by lookup, never retried against LDH).
- All matches = one candidate → insert one `discovery_sightings` row (`matched_key` = strongest of provider>identifier>url, `seen_url` = found_url).
- Matches point to DIFFERENT candidates → conflict. No sighting, no merge, no insert. `needs_review` is not used: setting it on existing rows would be attributing the conflict to a candidate; the guard trigger allows it, but no single row is correct. The conflict is returned in the run result only.

## 5. Reservation / quota algorithm

Limits: 20 per rolling 24h AND 600 per 30 days; both must pass (stricter wins).
1. Expire stale runs: `UPDATE discovery_runs SET status='interrupted', error_code='stale_heartbeat', finished_at=now() WHERE provider='ldh' AND status='running' AND heartbeat_at < now() - interval '120 seconds'`. `interrupted` is in `discovery_runs_status_check` [V]; error_code required for non-running/succeeded and finished_at required [V]. Numbers: LDH fetch timeout 30 s (AbortSignal), function budget well below; expiry 120 s = 4× timeout, so a live run is never expired.
2. Exclusivity first: `INSERT discovery_runs (provider='ldh', status='running', triggered_by=userId)`. Unique index `discovery_runs_one_running_per_provider` (provider) WHERE status='running' [V] → loser gets 23505 → returns `busy`, makes no LDH call, writes nothing else.
3. Quota: count `discovery_queries` joined to runs with provider='ldh' and `counted_against_budget=true`, `sent_at > now()-24h` and `> now()-30 days`. Over limit → run `budget_exhausted` (error_code `quota_24h`/`quota_30d`), no call.
4. Reserve before dispatch: insert `discovery_queries` row with `status='sent'`, `counted_against_budget=true`, `sent_at=now()`, attempt=1; `calls_reserved=1, calls_used=1` on the run. Only after this commits is fetch started. A timeout, crash or lost response therefore stays counted.
5. Dispatch once (no retry). On response update query (`succeeded`/`failed`, http_status, error_kind/code, result_count) and run status, heartbeat.
Remaining race [N]: two runs can't overlap per provider, so the count in step 3 can't be raced by another LDH run.

## 6. Error table

| Case | Query status / error_kind | Run status / error_code | LDH called? |
|---|---|---|---|
| not staff | — | none | no |
| LDH_API_KEY missing | — | failed / config_missing | no |
| another run active | — | (no row) busy | no |
| quota | — | budget_exhausted / quota_24h·quota_30d | no |
| 401/403 | failed / auth | failed / ldh_auth | yes, counted |
| 429 | failed / rate_limit (retry_after if header) | failed / ldh_rate_limit | yes, counted |
| 422/400 | failed / bad_request | failed / ldh_bad_request | yes, counted |
| 5xx | failed / server | failed / ldh_server | yes, counted |
| timeout 30 s | failed / timeout | failed / ldh_timeout | yes, counted |
| network | failed / network | failed / ldh_network | maybe, counted |
| bad JSON/shape | failed / parse | failed / ldh_parse | yes, counted |
| some hits unusable/conflict | succeeded | partial / hits_skipped | yes |
error_detail: fixed short codes only (≤300), never response text.

## 7. /discovery list (read-only)

Columns: Found at · Title (found_title) · Identifier · Country · Authority · Language · Doc type · Returned URL (link text "Returned URL", rel=noreferrer, never "Official URL") · Confidence ("hypothesis") · Sightings count · Stage/outcome. Plus a search form (q, namespace, country, language, dates) and a result banner showing created/sighted/unusable/conflicts and quota used. No approve/collect buttons.

## 8. Mocked tests (acceptance criteria)

Mocks replace fetch and the Supabase client; they do NOT verify real triggers, RLS, unique indexes or CHECK constraints [N].
1. Body contains only allowed fields, top_k=10, no result_detail; URL is `/v1/search`.
2. Allowlist: hit with snippet/summary/text → none appear in inserted rows or logged/error values.
3. URL kept byte-identical (http, query params, trailing slash, utm); http → key_url null.
4. Invalid source/source_id/authority/country → null, never rewritten; no key → unusable.
5. Dedup: no match → insert; one candidate → sighting; two candidates → conflict, zero writes to candidates/sightings.
6. Busy (23505 on run insert) → fetch call count 0.
7. Quota 20/24h and 600/30d each block with fetch count 0.
8. Query row marked counted before fetch is invoked (order asserted); timeout leaves it counted, no retry (fetch called exactly once).
9. Stale expiry UPDATE uses status='running' and heartbeat 120 s filter.
10. Non-staff → no fetch, no writes. Error codes per table §6.
Full suite (104 existing) must stay green; typecheck clean.

## 9. Limitations

- DB behaviour (triggers, indexes, RLS) only proven by real run [N]; Phase 1A rollback checks [E].
- Real LDH field formats (country case, authority style) unknown [N]; many hits may become unusable rather than rewritten.
- LDH_API_KEY presence not re-checked this round [N].
- Free-plan terms question remains open.
- Quota counted locally; LDH's own counter (`/v1/usage/me`, rolling 24h [V]) not consulted in this slice.

## 10. One real acceptance search (needs separate authorization)

1. Owner adds `LDH_API_KEY` in project secrets (never in chat); publish if testing on the live site.
2. Staff opens /discovery, enters q="ship registration", namespace=legislation, country=MT, clicks Search once.
3. Expected writes: 1 discovery_runs, 1 discovery_queries (counted), ≤10 candidates and/or sightings.
4. Verify via read queries: run status, query counted_against_budget=true, candidates contain no snippet/text, URLs as returned.
5. Stop: any non-2xx, any stored provider text, any second call. No repeat automatically. Nothing deleted.
