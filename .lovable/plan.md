# Review & publication controls + raw provenance fields

One migration, one guarded-read change, one screen change. Nothing else in scope.

## 1. Schema changes

**New enums**
- `public.verification_status`: `unreviewed`, `reviewed`, `rejected`
- `public.publication_status`: `internal_only`, `eligible`

**`public.normalized_items`** (new columns)
- `verification_status verification_status NOT NULL DEFAULT 'unreviewed'`
- `publication_status publication_status NOT NULL DEFAULT 'internal_only'`
- `reviewed_by uuid NULL`, `reviewed_at timestamptz NULL` (internal only, never public)

Existing rows take the defaults automatically, so the pilot item starts unreviewed / internal_only.

**`public.raw_items`** (new nullable columns, no defaults, no backfill of existing content)
- `canonical_url text`, `http_status integer`, `content_type text`, `language text`,
  `apify_actor_id text`, `apify_run_id text`, `collector_version text`

**View `public.staff_item_tier_matrix`** is recreated with the two new status columns added; it stays profile-agnostic (objective facts + resolved tier per active profile) and keeps its existing grants. No policy JSON is added to it.

## 2. Constraint / trigger logic

Single table-level CHECK on `normalized_items`, which expresses both rules and is enforced on insert and update:

```text
CHECK (
  (publication_status = 'eligible' AND verification_status = 'reviewed')
  OR
  (publication_status = 'internal_only' AND verification_status <> 'rejected')
  OR
  (publication_status = 'internal_only' AND verification_status = 'rejected')
)
```
i.e. `eligible` implies `reviewed`; `rejected` implies `internal_only`. No trigger needed — the rule is immutable and expressible as a CHECK.

`updated_at` continues to be maintained by the existing `set_updated_at` trigger.

## 3. Guarded public read path

`public.api_list_items` is replaced (same signature, still `SECURITY DEFINER`, still `SET search_path = ''`, still `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` and `GRANT EXECUTE TO service_role` only). One added filter in the scan:

```text
AND ni.verification_status = 'reviewed'
AND ni.publication_status  = 'eligible'
```

Tier gating, exposure/promotion, cursor pagination and `updated_since` are unchanged. The returned column list is unchanged, so no new field leaks: no review metadata, no policy JSON, no raw payload, no Apify/run/source-secret data. `src/routes/api/public/v1/items.ts` needs **no** change — it already forwards only the RPC's columns.

## 4. Staff UI changes (Collected items only)

- Two extra columns rendered with the existing 21st.dev `hud-status-1` badge (`StatusBadge`): verification and publication status.
- Action controls built from the existing `glow-button` wrapper, shown only for legal transitions:
  - `unreviewed` → **Mark reviewed** / **Reject**
  - `reviewed` + `internal_only` → **Make eligible** / **Reject**
  - `reviewed` + `eligible` → **Set internal only**
  - `rejected` → **Reopen as unreviewed** (single control; no path to eligible)
- New authenticated server function `setItemReviewState` in `src/lib/items.functions.ts` (auth middleware, RLS as the staff user), which writes the pair atomically and stamps `reviewed_by`/`reviewed_at`. Invalid pairs are rejected both in the function and by the DB check.
- Optional filter by verification/publication status reuses the existing `Field` + `inputClass` select — no new shadcn primitives, no visual-direction change.
- The "jurisdiction not stated" / "category not stated" labels stay exactly as they are.

## 5. Migration and verification sequence

1. Migration (single call): create both enums → add the four/two columns → add the CHECK → recreate `staff_item_tier_matrix` with grants → replace `api_list_items` with the two extra predicates and re-apply REVOKE/GRANT → objective backfill of the pilot raw item (see risk 1).
2. Regenerate types, then ship the server function and the Collected items UI.
3. Verification, in order:
   1. Pilot item left `unreviewed` → public API returns zero items.
   2. Set `reviewed` + `internal_only` → public API still returns zero items.
   3. Set `reviewed` + `eligible` → returned for the `auramaris-legal-compliance` key; a key on a profile whose policy hides that tier still gets nothing.
   4. Attempt `rejected` + `eligible` → rejected by the CHECK.
   5. Inspect the public JSON: only id, source_url, jurisdiction_hint, category, payload, tier_label, policy_version, collected_at, updated_at.
   6. Compare `raw_items` content hash, raw payload, facts snapshot and `collected_at` before/after — unchanged.
   7. Direct `anon` / `authenticated` call of `api_list_items` under `SET LOCAL ROLE` → permission denied.
   8. Supabase security linter → no new findings.

## 6. Ambiguity, risk, conflict — decide before BUILD

1. **Backfilling the pilot raw item conflicts with immutability.** `raw_items` denies UPDATE to all app roles; a migration runs as owner and could bypass that. From the saved Apify run I can objectively verify: `canonical_url = https://www.boe.es/buscar/act.php?id=BOE-A-2014-10344`, `content_type = text/html; charset=UTF-8`, `language = es`, `apify_run_id = VemEMweJ9f6AkrfXa`, `apify_actor_id = apify~website-content-crawler`. `http_status` and `collector_version` are not in the saved run data and stay NULL. **Assumption unless you say otherwise:** backfill those five values only, in the migration, and touch nothing else. Say the word and I leave the pilot row entirely NULL instead.
2. **Collector writes.** New crawls should populate these columns going forward. That is a small edit inside the existing sync path (`src/lib/collection.functions.ts`), reading canonical URL / content type / language from the Apify page metadata, with `canonical_url` derived server-side only — never by LogoriOn. Confirm you want it in this same batch; otherwise the columns stay NULL for future runs too.
3. **`collector_version` has no source of truth yet.** Proposal: a constant string in the collector module bumped by hand. If you prefer something else, name it now.
4. **Rejected items.** I assume `rejected` is reversible by staff (back to `unreviewed`). If it should be terminal, say so and I drop that control.
5. `language` on raw items is provenance only and never feeds `jurisdiction_hint`; jurisdiction stays NULL unless the page states it.
