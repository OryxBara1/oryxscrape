# Fix EUR-Lex collector filters (analysis + plan)

Live read-only queries against the CELLAR SPARQL endpoint were run today to answer the five questions.

## What the live data shows

Current hardcoded IDs (all four are wrong):

| ID | Real EuroVoc label |
|---|---|
| 3193 | goods and services |
| 4790 | fishing area |
| 5551 | police cooperation |
| 1499 | iodine |

Label lookup for the proposed list returns 5 of 7 labels:

| Label | Real ID |
|---|---|
| maritime safety | 5889 |
| maritime transport | 4522 |
| inland waterway transport | 4515 |
| pleasure craft | 4832 |
| waterway transport | 5210 |
| sea transport | not found |
| recreational craft | not found |

Resource types on 2024 CELEX L/R works include DIR, REG_IMPL, DIR_IMPL, REG_DEL, DIR_DEL and a large number of CORRIGENDUM (560).

## Answers

**1. Is label lookup feasible?** Yes. EuroVoc `skos:prefLabel` sits in the same store and resolves without SERVICE or GRAPH. Two proposed labels do not exist, so they would silently match nothing. Recommendation: keep the label list in TypeScript, but resolve labels to URIs in a small first query at the start of each run. Then run the main query with a `VALUES` list of those URIs. Log any label that resolves to nothing into `run_params`, so a bad label shows up instead of failing silently. Fallback if the lookup fails: stop the job and mark it failed, rather than running without the concept filter.

**2. AND vs OR.** EuroVoc and document type should both be required. The title keyword should NOT be a hard filter. Titles such as "Directive 2014/90/EU on marine equipment" or "Regulation on ... EMSA" or "port State control" are borderline. Many amending acts are titled only "amending Directive 2009/16/EC" and would be dropped, so the risk of missing valid acts is real. Recommendation: use the title match as a relevance flag on the item (for example `payload.title_match = true/false`, plus a `title-unmatched` tag). The review screen can then sort matched items first. If you still want it strict, add "marine|seafar|crew|cargo|harbour|EMSA|SOLAS|MARPOL" to the pattern and accept some loss.

**3. Performance.** Joining labels on every document is slower, because a string join runs across all concept links. Resolving to URIs once up front (see #1) removes that cost. The main query stays as fast as today's `VALUES` query.

**4. Resource type coverage.** Resource type is populated on legislative works. A missing-type result did not appear in the sample, but the output was truncated, so this should be checked again during build. Do not use OPTIONAL: an act with no type should be excluded. Allowed set: DIR, REG, DIR_IMPL, REG_IMPL, DIR_DEL, REG_DEL. Delegated acts carry real maritime rules. CORRIGENDUM is excluded explicitly because it is the biggest source of noise.

**5. Title reliability.** `cdm:work_title` is inconsistent: some works have several untagged titles and some have none. Earlier runs also produced mostly blank titles. Recommendation: take the title from the English expression (`cdm:expression_belongs_to_work` + `cdm:expression_uses_language <.../language/ENG>` + `cdm:expression_title`). Fall back to `work_title` and then to CELEX. Apply the relevance flag from #2 to that title.

## Build steps (after approval)

1. In `src/lib/eurlex-collect.server.ts`:
   - Replace `EUROVOC_CONCEPTS` with `EUROVOC_LABELS`, using the 5 labels that exist. Optionally add verified extras such as "port", "ship", "maritime shipping" after a lookup.
   - Add `resolveEurovocConcepts()`, which queries labels to URIs, fails the job if the list is empty, and records resolved and unresolved labels in `run_params`.
   - Main query: resolved-URI `VALUES` + resource-type filter (6 types) + English expression title. Remove the broken STRSTARTS/REGEX filter.
   - Title relevance: flag and tag only, never a hard filter.
   - Bump `EU_COLLECTOR_VERSION` to `1.2.0`.
2. Before any data is written, run a live dry query over a 365-day window and review the titles by hand.
3. One real run through the cron route, then confirm the new items are `unreviewed` / `internal_only`.

## Out of scope

No schema changes, no changes to other collectors, and no changes to the 75 already-rejected items.
