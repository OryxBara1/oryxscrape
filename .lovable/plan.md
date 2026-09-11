# OryxScrape — Foundation Plan (v2)

## 1. Current state (verified)

- Supabase `nlthswnojvkqpooztans` (eu-central-1, OryxBara) is **connected and live** — a query succeeded and `supabase/config.toml` + the generated client both point at it. No new project will be created.
- The `public` schema is **completely empty**: no tables, functions, views, or storage buckets. Only Supabase's own `auth`/`storage` internals exist.
- Codebase is an untouched TanStack Start scaffold: placeholder home route, root layout, generated Supabase client/auth middleware, default shadcn set, Tailwind v4 via `src/styles.css`.
- GitHub: not connected yet — you do this via the chat "+" menu.

## 2. Points of disagreement / correction

Three things I want to flag before building; everything else in your round-2 answers I accept as written.

1. **Anon cannot be the caller identity for the read API.** `SET LOCAL ROLE anon` validation is fine and I will do it, but the bearer key must be verified server-side against a hash. Two options — I recommend (b):
   (a) RPC callable by `anon`, taking the raw key as an argument, hashing and matching inside.
   (b) RPC not exposed to `anon` at all; the TanStack `/api/public/v1/items` route resolves the key, then calls the RPC through the service role passing a validated `profile_id`. The key never travels through PostgREST, and the RPC stays unreachable from the internet.
   I will still write the RPC so it is *safe* under `SET LOCAL ROLE anon` (locked `search_path`, gates in `WHERE`, no policy reliance) and test it that way, per your requirement.
2. **Immutable facts on `raw_items` should be a snapshot copy, not a live FK read.** Your point (a) says propagate to `raw_items`; I will physically copy the three fact columns onto each `raw_items` row at insert, so editing a source later never rewrites history. Confirm that is the intent.
3. **T3 "recognized institutional/verified source" is not expressible from the three facts alone.** It needs a fourth objective fact on `sources`. I propose `institution_class` (enum: `government` / `intergovernmental` / `court` / `academic` / `professional_body` / `registered_media` / `commercial` / `unknown`) — still an objective fact, not a trust label. T3 then = `institution_class IN (...)` as defined by the profile policy, not hardcoded.

## 3. Tier policy condition schema (concrete)

Stored in `research_profile_tier_policies.policy` as jsonb but **strictly shaped and validated** by a Postgres `CHECK` + a validation function, so it is not free-form.

```text
policy := {
  "schema_version": 1,
  "default_tier": "T5",
  "rules": [ Rule, ... ]          // evaluated top-down, first match wins
}

Rule := {
  "tier":  "T1" | "T2" | "T3" | "T4" | "T5",
  "when":  Node
}

Node := Condition | Group

Group := { "op": "and" | "or" | "not", "children": [ Node, ... ] }

Condition := {
  "field":    <one of the whitelisted fields below>,
  "operator": "eq" | "neq" | "in" | "not_in" | "is_true" | "is_false",
  "value":    <scalar or array; omitted for is_true / is_false>
}
```

Whitelisted fields (closed list — anything else fails validation):

| field | type | allowed operators |
|---|---|---|
| `is_official_domain` | boolean | `is_true`, `is_false`, `eq` |
| `is_primary_document` | boolean | `is_true`, `is_false`, `eq` |
| `traceability_level` | enum | `eq`, `neq`, `in`, `not_in` |
| `institution_class` | enum | `eq`, `neq`, `in`, `not_in` |

Exposure policy is a sibling column, not inside `policy`:

```text
exposure := {
  "schema_version": 1,
  "visible_tiers": ["T1","T2","T3","T4"],
  "hidden_tiers_require_promotion": ["T5"]
}
```

Seeded profile `auramaris-legal-compliance`, policy v1 (your (h), literal):

```text
rules:
  T1: and[ is_official_domain is_true,
           is_primary_document is_true,
           traceability_level eq "direct_url" ]
  T2: and[ is_official_domain is_true,
           traceability_level in ["direct_url","domain_indicated"],
           is_primary_document is_false ]
  T3: and[ is_official_domain is_false,
           institution_class in ["government","intergovernmental","court",
                                 "academic","professional_body","registered_media"] ]
  T4: and[ traceability_level in ["third_party_hosted","domain_indicated"] ]
default_tier: T5
exposure: visible T1–T4, T5 requires per-profile promotion
```

Evaluation lives in one immutable SQL function `evaluate_tier_policy(policy jsonb, facts record) -> text` used by both the read RPC and the staff views, so there is exactly one interpreter.

## 4. Schema (described; one migration per step)

Every table: RLS enabled, explicit grants, no `anon` grants anywhere, `created_at` (+ `updated_at` and trigger where mutable).

- **enums** — `collection_method`, `traceability_level`, `institution_class`, `job_status`, `tier_label`, `audit_check_type`.
- **sources** — name, base URL, domain, collection method, robots.txt status, ToS status + reviewed date, active, notes, plus the objective facts: `is_official_domain`, `is_primary_document`, `traceability_level`, `institution_class`.
- **research_profiles** — id, slug, name, description, created_at.
- **research_profile_tier_policies** — profile_id, version, `policy` jsonb (CHECK-validated against §3), `exposure` jsonb, is_active, created_at. Append-only: a change inserts a new version and flips `is_active`; one active version per profile enforced by a partial unique index. No UPDATE except the activation flag; no DELETE.
- **collection_jobs** — source_id, optional `profile_id`, status, started/finished, counts (fetched/new/duplicate/failed), error text, run params, apify run id.
- **raw_items** — job_id, source_id, source_url, raw payload jsonb, `content_hash` (unique per source), collected_at, collection_method, plus the **snapshotted** four objective facts. Append-only: insert policy only, no update/delete policies.
- **normalized_items** — raw_item_id (unique), payload jsonb (title/summary/body/url/media/tags), first-class indexed `jurisdiction_hint` and `category`, review status, timestamps. **No global tier column, no global published flag.**
- **normalized_item_profile_exposure** — (normalized_item_id, profile_id) unique; `promoted` boolean, promoted_by, promoted_at, note. This is the per-profile T5 promotion from your (f).
- **consumer_keys** — consumer app name, `profile_id` NOT NULL FK, key hash (never plaintext), active, last_used_at, revoked_at. No plaintext or `secret_ref` ever returned by any API or log.
- **audit_events** — check type, target ref, result, findings jsonb, run timestamp.
- **RPC `api_list_items(p_profile_id, p_updated_since, p_cursor, p_limit)`** — SECURITY DEFINER, `SET search_path = ''`, REVOKE FROM PUBLIC, explicit GRANT. Loads the profile's active policy, evaluates tiers **in SQL**, filters by exposure + per-profile promotion, applies `updated_since` and keyset pagination at SQL level, and returns per row: normalized payload, `jurisdiction_hint`, `category`, resolved `tier_label`, `policy_version`. Never returns raw payload, source internals, or policy definitions.
- **Staff view** — profile-agnostic: raw facts plus, for every profile, how its active policy would classify the item (your (g)).

## 5. UI mapping (21st.dev)

| Component | Where | Note |
|---|---|---|
| dashboard-sidebar | Shell for all screens | Replaces default `sidebar.tsx` |
| glowing-card | Dashboard metrics | Replaces `card.tsx` usage |
| glare-cards | Dashboard alerts, audit highlights | — |
| animated-status-badge | Job status, tier labels per profile | Replaces `badge.tsx` usage |
| hud-status-1 | Live job monitor header | — |
| v-table-3 | Items browser + sources list | Replaces `table.tsx` usage |
| glow-button | All actions | Replaces `button.tsx` usage |
| v-skeleton-8 | All loading states | Replaces `skeleton.tsx` usage |

Conflicts to expect: registry components are installed with the shadcn CLI and often import default primitives internally — those stay, but **no screen imports a default primitive directly**. Several ship `motion`/`framer-motion` and their own CSS variables, which get folded into `src/styles.css` under a dark glass/glow token set. Installs need network access; if a URL fails I stop and report rather than substitute. Forms, dialogs, selects and filter inputs have no registry equivalent in your list — I will style those from existing primitives unless you name replacements.

## 6. Build roadmap (isolated, individually testable)

Phase 0 — governance
1. You connect GitHub. You add `APIFY_API_TOKEN` in the Supabase dashboard (project-scoped; I will never hardcode it).

Phase 1 — schema, one migration per step, no UI in any of them
2. Enums + `updated_at` trigger function.
3. `sources` (incl. the four objective facts).
4. `research_profiles` + `research_profile_tier_policies` + the policy CHECK/validation function.
5. Seed `auramaris-legal-compliance` policy v1 (data step).
6. `collection_jobs`.
7. `raw_items` (append-only, snapshotted facts, content-hash uniqueness).
8. `normalized_items` (+ indexes on `jurisdiction_hint`, `category`, `updated_at`).
9. `normalized_item_profile_exposure`.
10. `consumer_keys` + `audit_events`.
11. `evaluate_tier_policy` + `api_list_items` RPC, plus the profile-agnostic staff view.
12. Verification step: run the RPC under `SET LOCAL ROLE anon` and as an authenticated staff user; confirm keyset pagination and `updated_since`; confirm no leakage of key hashes or policy bodies. Then the security linter.

Phase 2 — access + shell
13. Invite-only auth: disable self-signup, invite `rogerio@oryxbara.com`, staff-only gate on all app routes.
14. Install the 8 registry components; dark glass/glow theme tokens.
15. Sidebar shell + empty routed screens.

Phase 3 — screens (one step each)
16. Dashboard. 17. Sources (incl. fact editing). 18. Collection jobs. 19. Items browser (raw vs normalized, filter by profile lens / tier / tag / jurisdiction / category, per-profile promotion action). 20. Audit log. 21. Profiles & policy versions screen (view history, publish new version). 22. Consumer keys screen.

Phase 4 — read API
23. `/api/public/v1/items` — bearer key resolved server-side to a `profile_id`, delegating to the RPC. Pagination + `updated_since` from day one.

Phase 5 — collection (last)
24. Apify integration writing only into `raw_items`.
25. Normalization step `raw_items` -> `normalized_items`.
26. LogoriOn (AI gateway) for OCR / messy-HTML structuring inside the normalization step.

## 7. Remaining confirmations

1. Read-API key handling: option (b) above (key never reaches PostgREST) — agreed?
2. Facts snapshotted onto `raw_items` at insert rather than read live from `sources` — agreed?
3. Adding `institution_class` as a fourth objective fact so T3 is expressible — agreed, and is the proposed value list right?
