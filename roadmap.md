# OryxScrape roadmap

Phase 1 — schema (one migration per step, confirm after each)
- [x] Step 1: enums + shared updated_at trigger function
- [x] Step 2: sources (incl. 4 objective facts)
- [x] Step 3: research_profiles + research_profile_tier_policies + policy validation
- [x] Step 4: seed auramaris-legal-compliance policy v1
- [x] Step 5: collection_jobs
- [x] Step 6: raw_items (append-only, snapshotted facts, content hash)
- [x] Step 7: normalized_items (+ jurisdiction_hint, category indexes)
- [x] Step 8: normalized_item_profile_exposure
- [x] Step 9: consumer_keys + audit_events
- [x] Step 10: evaluate_tier_policy + api_list_items RPC + staff view
- [x] Step 11: verify under SET LOCAL ROLE anon + security linter

Phase 2 — invite-only auth, 21st.dev shell
- [x] Step 12/13: invite-only auth (invite sent, sign-in page, all routes gated)
- [x] Step 14: 8 21st.dev components installed with the project API key (API_KEY_21ST secret)
- [x] Step 15b: temporary shell replaced by the real dashboard-sidebar + registry components
- [x] Step 14b: dark glass/glow theme tokens in src/styles.css
- [x] Step 15: 5 gated screens + navigation (temporary shell until dashboard-sidebar installs)
Phase 3 — screens (real Supabase data via server functions)
- [x] Step 16: Dashboard metric cards
- [x] Step 17: Sources CRUD (objective facts, ToS/robots, active toggle)
- [x] Step 18: Collection jobs (read-only)
- [x] Step 19: Items browser (staff_item_tier_matrix + promotion toggle)
- [x] Step 20: Audit log (filter by check_type/result)
Phase 4 — read API
- [x] Step 23: GET /api/public/v1/items (bearer key, cursor + updated_since, limit capped at 200) + Consumer keys screen
Phase 5 — Apify collection, normalization, LogoriOn
- [x] BOE source seeded (boe.es, official/primary/direct-url/government)
- [x] Apify generic crawler client (server-only, token from secret)
- [x] Manual "Run collection" + Sync + Normalize on the Collection jobs screen
- [x] Raw items immutable, deduped by content hash, facts snapshotted
- [x] LogoriOn normalization into normalized_items
- [ ] Diff first BOE run against the AuraMaris baseline (Rogerio)
- [ ] Scheduling (only after the baseline diff is approved)

Phase 6 — Drive handoff to AuraMaris (approved, OryxScrape side only)
- [ ] Pre-implementation build spec (tables/migration, files, permissions, tests, rollback)
- [x] Migration: exchange_handoffs, exchange_suppressions, search_terms + enums
- [ ] Handoff packaging (extracted_text_only artifact + metadata.json)
- [ ] Drive staging upload to 01_Pending_Review
- [ ] Manual feedback sync + ACK generation
- [ ] Exact SHA-256 suppression only
- [ ] Passive Search Lexicon screen
- [ ] 8-12 document pilot

Blocked on user
- Disable self-signup in Supabase Auth settings (disable_signup is currently false)
- GitHub connection
- APIFY_API_TOKEN added in Supabase dashboard
- Google-side setup: two technical Drive identities + Shared Drive membership (no build until confirmed)
- Post-pilot acceptance scenario: local/island/port-authority source case


Phase 7 — Greece source + weekly scheduled collection (approved 2026-09-16)
- [x] Migration: sources.schedule_enabled/schedule_notes/last_scheduled_run_at
- [x] fek.server.ts + fek-collect.server.ts (et.gr ΦΕΚ Β', last 4 issues rolling)
- [x] scheduler.server.ts reusing existing collection internals
- [x] /api/public/cron/collect + /api/public/cron/finalize (LOVABLE_CRON_SECRET)
- [x] Sources screen weekly-schedule toggle
- [x] Slack link (#auramaris-compliance): weekly summary + per-failure alert
- [x] Greek search_terms rows from the taxonomy
- [x] Targeted hunts: ES RD 1188/2025, GR ΦΕΚ Β' 4559/2026; duplicate re-run test
- [x] Weekly flag enabled: Spain, Croatia, Germany, France, Greece
- [ ] BLOCKED: timer itself — pg_cron HTTP callbacks unsupported on user-managed Supabase; needs an external scheduler calling /api/public/cron/*
- [ ] Italy: listing is JS-paginated, no automatic discovery of new ordinances yet

Phase 8 — collect-fr-legifrance Supabase Edge Function
- [ ] Edge Function `collect-fr-legifrance`: PISTE OAuth (_ORYXSCRAPE secrets), publication-date-bounded LODA search since last successful France job (fallback 90d), pagination ceiling 5 pages / 100 docs per concept, nautical sweep pass, raw_items dedup by content hash, normalized_items insert, job row succeeded/failed, HTTP 500 JSON on failure
- [ ] Weekly Monday 03:00 UTC trigger wired externally (separate step)
- [ ] Backfill run after 1–2 clean weekly runs (deferred, not this deploy)
