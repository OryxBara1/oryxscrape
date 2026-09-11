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
- [ ] Step 14: install 8 21st.dev components (BLOCKED: registry returns 401, needs API key)
- [x] Step 14b: dark glass/glow theme tokens in src/styles.css
- [x] Step 15: 5 gated screens + navigation (temporary shell until dashboard-sidebar installs)
Phase 3 — screens (real Supabase data via server functions)
- [x] Step 16: Dashboard metric cards
- [x] Step 17: Sources CRUD (objective facts, ToS/robots, active toggle)
- [x] Step 18: Collection jobs (read-only)
- [x] Step 19: Items browser (staff_item_tier_matrix + promotion toggle)
- [x] Step 20: Audit log (filter by check_type/result)
Phase 4 — read API (/api/public/v1/items)
Phase 5 — Apify collection, normalization, LogoriOn

Blocked on user
- Disable self-signup in Supabase Auth settings (disable_signup is currently false)
- 21st.dev registry API key / authenticated CLI login
- GitHub connection
- APIFY_API_TOKEN added in Supabase dashboard
