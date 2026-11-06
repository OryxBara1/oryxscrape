# Plan: minimal human triage for discovery candidates

Status: PLAN ONLY. Nothing runs until a separate written build order. [V] verified now, [E] reported earlier, [N] not tested.

## 1. Current state (read from the real database)
- 14 candidates, all `stage=lead`, `outcome=open`, `country_code=MT`, `needs_review=false` [V].
- `outcome` allowed values: `open`, `out_of_scope`, `rejected`, `duplicate` [V].
- A reason (`outcome_reason`, max 500 chars) is required by the database for `out_of_scope` and `rejected` [V]. `duplicate` requires `same_as_candidate_id`, which can't point to the candidate itself [V].
- `needs_review=true` requires `review_note` (max 500 chars) [V]. `reviewed_by` and `reviewed_at` columns exist [V].
- `stage` allowed values go from `lead` to `reviewed_copy`. No database rule limits stage moves [V].
- Guard trigger `discovery_candidates_guard` [V]:
  - Fixed after creation: provider, provider_source, provider_source_id, found_url/title/identifier, found_at, run_id, query_id, created_at.
  - `outcome_history` can only be added to. Each outcome or reason change adds an entry with from/to/reason/user/time.
  - Changes to `needs_review` / `review_note` are **not** recorded in history.
- Access: staff can read, insert and update; nobody can delete [V]. Sightings: staff can read and insert, and existing rows can't be changed [V].

## 2. Transitions (as the database allows today)
- open -> out_of_scope / rejected (reason required) [V].
- out_of_scope / rejected -> open (reopen). The database allows this with no extra rule [V].
- Any outcome -> any other outcome is also allowed by the database. Only the app would restrict it.

## 3. Gaps (no migration proposed)
- G1: there are no database transition rules. The slice enforces them in the server function: only open -> out_of_scope/rejected, and those two -> open with a mandatory reopen reason. Duplicate is not part of this slice.
- G2: `needs_review` / `review_note` changes leave no history; only the last note is kept. This is acceptable for the first slice. Recording them would need a migration (not proposed now).
- G3: when a candidate is reopened, `outcome_reason` is reused to hold the reopen reason. That reason is kept in history, but "open" then carries text, which is allowed. Stated as a limitation.
- No schema change is needed for this scope.

## 4. Proposed files and changes
- `src/lib/discovery-triage.ts` (new, pure): `validateTriage(current, action)` with the transition rules, a reason of 3–500 characters after trimming, and a note for needs-review.
- `src/lib/discovery.functions.ts`:
  - Extend `listDiscoveryCandidates` with stage, outcome and country filters.
  - Add `getDiscoveryCandidate(id)`, which returns the candidate, its `outcome_history` and its sightings in time order.
  - Add `triageDiscoveryCandidate({id, action, reason|note})`. It requires a signed-in user and an `is_staff()` check through the user's own database access. It reads the current row, runs `validateTriage`, and updates only `outcome`, `outcome_reason`, `needs_review`, `review_note`, `reviewed_by` and `reviewed_at`, with a guard on the expected current outcome to avoid races.
- `src/routes/_authenticated/discovery.tsx`: filter selects and a clickable row that opens a detail panel. Reuses `DataTable`, `StatusBadge` and `GlowButton`.
- The panel shows the found fields, the sightings, the history, and the actions: Reject, Out of scope, Needs review, Clear review, Reopen. The reason or note box is mandatory.
- Untouched: the LDH client, the search, stage, collection, sources, schema and alerts.

## 5. Risks
- Two staff acting on the same candidate at once: handled by the expected-outcome guard. The second person sees a "changed, reload" message.
- The reopen rule lives only in the app, so a direct database edit by staff could skip it (G1).
- The 4 candidates with empty provider references are shown as they are and not fixed.
- None of this has been tested in a real browser session [N].

## 6. Mock tests (`src/lib/discovery-triage.test.ts`)
1. open -> rejected with a reason passes; an empty or whitespace reason fails.
2. open -> out_of_scope with no reason fails.
3. rejected -> open needs a reason; open -> open fails.
4. Any change to `duplicate` or `stage` is refused.
5. needs_review=true without a note fails; clearing it keeps the outcome.
6. A reason over 500 characters is refused.
7. The update only contains the allowed columns (no lead fields, no history).
8. A non-staff caller is refused before any write.
9. A mismatch on the expected outcome produces a conflict and no write.
- The existing 128 tests stay green, and the type check stays clean.
