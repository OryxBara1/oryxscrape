# LDH discovery — fix provider references, initial sightings, neutral counts

Status: PLAN ONLY. Nothing applied, published or called. Labels: [V] verified this session, [E] reported earlier, [N] not tested.

## 1. What blocks provider references today
- [V] Code: `RE.providerSource = /^[A-Za-z0-9_.:-]{1,100}$/` (no `/`); `mapHit` nulls source and source_id together if either fails.
- [V] DB CHECK `discovery_candidates_provider_source_check`: same regex, no `/`.
- [V] DB CHECK `provider_source_id_check` already allows `/`.
- [V] `key_provider_shape`: `key_provider = 'prov:'||provider||':'||lower(provider_source)||':'||provider_source_id`; does not restrict characters, so `/` passes once the source CHECK allows it.
- [V] Unique partial index `discovery_candidates_key_provider_uq` (also on key_identifier, key_url). No change needed.
- [V] Guard `discovery_candidates_guard`: provider_source/provider_source_id immutable after insert; no character rule. No change needed; the 7 existing rows stay NULL (cannot be filled, as decided).
- [E] Real values in the 2026-11-06 response are unknown; "COUNTRY/name" is the documented OpenAPI form only.

Collision risks (noted, not fixed):
- [V] `lower(provider_source)`: `FR/CNIL` and `fr/CNIL` with the same source_id give the same key_provider. Second insert hits the unique index, code re-looks up and records a sighting on the first candidate (provider stored as first received). Acceptable for one provider.
- [V] `:` is allowed in both parts and is also the separator, so `a:b`+`c` and `a`+`b:c` collide. Pre-existing; smallest alternative if it ever matters: drop `:` from the source regex. Not done now.

## 2. Proposed migration (not applied)
```sql
ALTER TABLE public.discovery_candidates
  DROP CONSTRAINT discovery_candidates_provider_source_check,
  ADD CONSTRAINT discovery_candidates_provider_source_check
    CHECK (provider_source ~ '^[A-Za-z0-9_.:/-]{1,100}$');

ALTER TABLE public.discovery_sightings
  DROP CONSTRAINT discovery_sightings_matched_key_check,
  ADD CONSTRAINT discovery_sightings_matched_key_check
    CHECK (matched_key = ANY (ARRAY['initial','provider','identifier','url']));
```
- Impact: widens two CHECKs only; existing rows all still valid; no grants, RLS, indexes, triggers or data touched. [V for current definitions; N for apply]
- `initial` is needed because the current CHECK [V] only allows provider/identifier/url, and an initial sighting is not a match.
- Rollback (restore old CHECKs): only valid while no row has `/` in provider_source and no sighting has `matched_key='initial'`; since rows are never deleted, rollback after first use is not possible — instead revert code and leave the wider CHECK. [N]
```sql
-- rollback, only if no dependent rows exist
ALTER TABLE public.discovery_candidates DROP CONSTRAINT discovery_candidates_provider_source_check,
  ADD CONSTRAINT discovery_candidates_provider_source_check CHECK (provider_source ~ '^[A-Za-z0-9_.:-]{1,100}$');
ALTER TABLE public.discovery_sightings DROP CONSTRAINT discovery_sightings_matched_key_check,
  ADD CONSTRAINT discovery_sightings_matched_key_check CHECK (matched_key = ANY (ARRAY['provider','identifier','url']));
```

## 3. Code changes
- `src/lib/ldh-discovery.server.ts`
  - Source regex gains `/`, matching the DB. Values kept exactly as received (no trim/case change); key_provider keeps `lower()` to match the DB CHECK.
  - After a successful insert of a new candidate, insert one sighting `matched_key:'initial'`, same run/query, `seen_url = found_url`. Counted separately from matches.
  - Result gains `matched` (sightings on existing candidates) instead of `sighted`.
- `src/routes/_authenticated/discovery.tsx`: banner text exactly "X results · Y new candidates · Z matches with existing candidates · U unusable · C conflicts".
- `src/lib/ldh-discovery.server.test.ts`: new tests (section 5).
- Not touched: schema beyond the 2 CHECKs, collection, storage, scheduler, existing rows.

## 4. How dedup stays document-level (current `decideDedup`, unchanged) [V]
- Each hit is compared on all keys it has; every candidate matched by any key is collected.
- One candidate matched → sighting on it; key reported in order provider > identifier > url.
- Two or more different candidates matched → conflict, nothing written for that hit.
- Same URL, different source_id (two articles of one law): hit 2 has a new key_provider (matches nothing) and the same key_url (matches candidate A) → sighting on A via `url`. No new candidate. No key is added to A (keys are set at insert only).
- key_provider matches nobody, key_url matches A → sighting on A (url decides).
- key_provider matches A, key_url matches nobody → sighting on A (provider).
- key_provider matches A, key_url matches B → conflict (existing rule).
- Within one response: hit 1 inserted, hit 2 with same URL then finds it → match. Banner does not say whether a match was same-response or earlier.
- Limit [N]: an article hit with a provider reference and no usable URL, for a law already stored by URL only, becomes a new candidate. Without granularity fields (not added now) this cannot be resolved; smallest alternative later: staff marks it `duplicate` with `same_as_candidate_id` (already in schema).

## 5. Tests to add (mocks)
1. Source `FR/CNIL` + id `X/1` is kept exactly; key_provider = `prov:ldh:fr/cnil:X/1`.
2. Invalid source still nulls the pair (no half reference).
3. New candidate → exactly one sighting `initial`, created=1, matched=0.
4. Existing candidate matched by URL → one sighting `url`, no insert.
5. Two article hits, same URL, different source_id, same response → 1 candidate, 1 `initial` + 1 `url` sighting.
6. Provider matches A, URL matches B → conflict, no writes.
7. Case-only source difference → unique violation path resolves to sighting on first candidate.
8. Banner counts map to the new fields.
- Existing 122 tests stay green; type check clean.

## 6. Why the initial sighting disappeared [V partly]
- None of the last 8 revisions of the plan file mention an initial sighting; it existed only in the first chat plan and was dropped when the plan was rewritten (revision before 2ac8e48). Implementation followed the revised plan. Not blocking.

## 7. Order (published revision a3d0d73 must keep working)
1. Apply migration first. Widened CHECKs accept everything a3d0d73 writes; a3d0d73 never writes `/` or `initial`. [V by reading constraints; N for apply]
2. Merge code + run tests.
3. Publish only on separate owner authorization.
4. One real LDH search only on separate authorization.

## Limits
- Provider values of the 7 existing candidates stay unknown/NULL.
- issuing_authority/found_identifier mapping not changed in this plan.
- No granularity fields; article-level identity is not stored.
