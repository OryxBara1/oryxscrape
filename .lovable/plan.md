# Plan — "Approve for collection" (human decision only)

Labels: [V] verified this turn from migrations/code, [E] reported earlier, [N] not tested.

## 1. What `approved_for_collection` means today
- [V] It is only one allowed value of `discovery_candidates.stage` (CHECK: lead, identified, source_located, approved_for_collection, collected, reviewed_copy). Nothing in the DB reacts to it: no trigger, function or job reads it.
- Should mean: "a staff member decided this lead is worth fetching later." It must NOT imply: a source exists, a job was created or run, the document is genuine/trusted, the provider values are correct, or anything is published or exposed.

## 2. Transitions
- [V] DB enforces: stage value list; `prefilled_stages` subset of the same list; lead fields immutable; outcome history append-only (written by the guard trigger). The guard trigger does NOT check stage order and does NOT record stage changes in history.
- [V] Today the app never changes stage (triage excludes it). All 14 candidates are `lead/open` [E].
- Proposed, app-enforced only: `lead -> identified -> source_located -> approved_for_collection`, plus `approved_for_collection -> source_located` (withdraw approval, reason required). No skipping, no moves into `collected`/`reviewed_copy` (those belong to the later collection step).

## 3. Minimum preconditions to approve
- outcome = `open`; `needs_review` = false; stage = `source_located`.
- `identified` requires `confirmed_title` or `confirmed_identifier` (3-500 / <=300 chars).
- `source_located` requires `confirmed_source_url` (https, exact as typed, no rewriting, <=4000).
- Approval requires a reason/note (3-500 chars).
- New UI fields: inputs for `confirmed_title`, `confirmed_identifier`, `confirmed_source_url` (typed by the human; never copied from provider text), stage buttons, approval note. Columns already exist [V].
- `confidence` per field (hypothesis/confirmed): set to `confirmed` only for fields the human typed. Optional; can be deferred.

## 4. Boundary to collection (not designed now)
- Later, separate step: a human picks an approved candidate, then uses the EXISTING `createSource` (sources.functions.ts) and `startCollectionJob` (collection.functions.ts) flows. Only then would `source_id` / `collection_job_id` / `raw_item_id` be filled. Approval writes none of these, and `retrieval_state` stays `none`.

## 5. Schema gaps (no migration proposed)
- G1: stage changes have no history (trigger only logs outcome). Workaround without migration: store the approval note in `review_note`? Rejected — that conflicts with needs_review meaning. Choice: keep current state only, record limitation (same as accepted G2). If the owner wants stage history, exact SQL would be presented separately before any change.
- G2: no column for approved_by/approved_at; reuse `reviewed_by`/`reviewed_at` (server-set). Limitation: these show the last human action, not specifically the approval.
- G3: where to keep the approval note: reuse `outcome_reason`? No — only valid with non-open outcome semantics. Therefore approval note is NOT persisted unless G1 is resolved. Decision needed from owner: (a) no note stored, or (b) a migration adding stage history (SQL shown first).
- No gap blocks a note-free approval.

## 6. Files, risks, tests
- `src/lib/discovery-triage.ts`: add actions `confirm_fields`, `mark_identified`, `mark_source_located`, `approve_for_collection`, `withdraw_approval` with validation and explicit patches (only stage, confirmed_*, confidence, reviewed_by, reviewed_at).
- `src/lib/discovery.functions.ts`: server functions reuse staff check + user's own client; select add stage/confirmed_*.
- `src/components/discovery-candidate-panel.tsx`: fields + buttons; copy states "Approval does not create a source or start collection."
- Concurrency: UPDATE ... where id, updated_at = original string, outcome = expected, stage = expected; zero rows = conflict, no retry; reviewer from `context.userId`, time from server.
- Mock tests: each allowed/forbidden transition; preconditions (needs_review, non-open, missing confirmed fields, bad URL); stale stage/outcome/updated_at gives conflict with no write; browser reviewer ignored; patch never contains source_id/collection_job_id/raw_item_id/retrieval_state/lead fields; no call to createSource/startCollectionJob/LDH.
- Risks: stage rules are app-only — direct DB writes by staff can skip stages; reviewed_by overwritten by later actions.
- Not proven without real DB: RLS behaviour, trigger interaction, real concurrency.

## 7. Project constraints check
- No auto trust promotion: approval changes only stage. OK.
- LDH metadata/links only: confirmed fields are human-typed; no provider text stored. OK.
- No sharing DB/schema/credentials with consumer apps: nothing exposed; candidates are not in the public feed. OK.
- No rule broken by this plan.

## Decision needed
G3: approval with no stored note (no migration), or stage-history migration (SQL first).
