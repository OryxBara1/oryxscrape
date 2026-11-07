# Plan (revised) — "Approve for collection", human decision only

Replaces the previous approval plan (a26482e). Labels: [V] verified this turn, [E] reported earlier, [N] not tested. Nothing here has been implemented.

## 1. Search results and classification [V]
Repo-wide search (src, excluding generated types and migrations) for `discovery_candidates`, `approved_for_collection`, `source_located`, `collection_job_id`:
- `src/lib/discovery.functions.ts:109,116` — LDH search lookup/insert of candidates. Operational, staff-only (`requireSupabaseAuth` + `assertStaff` via `is_staff`). Does not read or set stage beyond default `lead`.
- `src/lib/discovery.functions.ts:142,160` — stage list used as a list filter. Display.
- `src/lib/discovery.functions.ts:204,236,245` — detail read and triage update (staff-only, user's own client). Operational, does not touch stage.
- `src/routes/_authenticated/discovery.tsx:104` — stage filter dropdown. Display.
- `src/lib/document-storage.server.ts:449` — `collection_job_id` on document copy sightings, not candidates. Unrelated.
- `src/integrations/supabase/types.ts` — generated types. Type.
- Tests: `discovery-triage.test.ts`, `ldh-discovery.server.test.ts`. Test.

No real conflicts: nothing reacts to stage, nothing links candidates to `source_id`/`collection_job_id` in code, no server route under `src/routes/api` exposes candidates, and the public feed (`api_list_items`) reads only `normalized_items`. Candidate RLS is staff-only [E, Phase 1A].

## 2. Final transitions (app-enforced; DB only checks the stage value list)
- `lead | identified | source_located -> approved_for_collection` in ONE guarded update, after the server validates all intermediate requirements. No existing rule forbids skipping: the guard trigger does not inspect stage [V].
- `approved_for_collection -> source_located` (withdraw): explicit confirmation only, no reason.
- Nothing else in this slice (no moves to `collected`/`reviewed_copy`, no save of `identified`/`source_located` alone).

## 3. Preconditions to approve (checked on the server against the current row)
- outcome = `open`, needs_review = false.
- confirmed title OR confirmed identifier, and confirmed source URL (https, kept exactly as given, no rewriting; length limits from existing CHECKs).
- "Confirmed" = the human pressed the explicit confirm control for that field after checking the source. Opening or saving the form never confirms anything.

## 4. Form behaviour
- Fields pre-filled as an editable PROPOSAL from existing candidate values (`confirmed_*` if set, else `found_title` / `found_identifier` / `found_url`). No retyping required.
- Each field shows "suggested by provider" or "verified by you". Editing a value resets its confirmation in the form.
- `confidence`: only keys `title`, `identifier`, `url` change, and only to `confirmed` when explicitly confirmed; all other keys are kept exactly.

## 5. Exact fields written
- Approve: `stage`, `confirmed_title`, `confirmed_identifier`, `confirmed_source_url`, `confidence`, `reviewed_by`, `reviewed_at`.
- Withdraw: `stage`, `reviewed_by`, `reviewed_at`.
- Guard: `id`, exact original `updated_at` string, expected `outcome`, expected `stage`. Zero rows = not applied, conflict message, no retry.
- `reviewed_by` from `context.userId`, `reviewed_at` from server clock; browser values ignored. User's own client, no service role.
- Never written: `source_id`, `collection_job_id`, `raw_item_id`, `retrieval_state`, lead fields, keys, `outcome*`, `needs_review`, `review_note`, `same_as_candidate_id`.
- No approval/withdrawal note stored. No migration.

## 6. Files to change
- `src/lib/discovery-triage.ts` — `approve` / `withdraw` validation, precondition check, patch builder, merged `confidence`.
- `src/lib/discovery.functions.ts` — two staff-only server functions; detail select adds `confirmed_*`, `confidence`.
- `src/components/discovery-candidate-panel.tsx` — proposal fields, confirm controls, Approve and Withdraw (with confirm dialog); copy: "Approval does not create a source or start collection. Reviewed by/at shows the last review action only."
- `src/lib/discovery-triage.test.ts` — new mock tests.
- `roadmap.md` — limitations.

## 7. Mock tests
- Approve from lead with all fields confirmed -> single update to `approved_for_collection`.
- Refused: outcome not open; needs_review true; no confirmed title/identifier; URL not confirmed or not https; unconfirmed edited value.
- Saving or opening never sets `confirmed`; other confidence keys preserved.
- Stale `updated_at`, outcome or stage -> conflict, no write, no retry.
- Browser-supplied reviewer/time ignored.
- Patch keys exactly the allowed list; no createSource / startCollectionJob / LDH call.
- Withdraw only from `approved_for_collection`; non-staff refused before any write; existing 141 tests stay green.

## 8. Risks and limitations
- Stage order and preconditions live in the app only; a direct DB write by staff could skip them.
- No history of approval/withdrawal; `reviewed_by/at` are overwritten by later actions.
- Approval says nothing about authenticity; trust is unchanged.

## 9. Not proven without real DB tests
RLS on the update, interaction with the guard trigger and CHECKs, real concurrency between two tabs, `confidence` CHECK acceptance of the merged object.

## 10. Project constraints
No trust promotion, no provider text stored (only existing metadata/links), nothing shared with consumer apps. No rule broken.
