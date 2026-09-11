# OryxScrape roadmap

Phase 1 — schema (one migration per step, confirm after each)
- [x] Step 1: enums + shared updated_at trigger function
- [x] Step 2: sources (incl. 4 objective facts)
- [x] Step 3: research_profiles + research_profile_tier_policies + policy validation
- [ ] Step 4: seed auramaris-legal-compliance policy v1
- [ ] Step 5: collection_jobs
- [ ] Step 6: raw_items (append-only, snapshotted facts, content hash)
- [ ] Step 7: normalized_items (+ jurisdiction_hint, category indexes)
- [ ] Step 8: normalized_item_profile_exposure
- [ ] Step 9: consumer_keys + audit_events
- [ ] Step 10: evaluate_tier_policy + api_list_items RPC + staff view
- [ ] Step 11: verify under SET LOCAL ROLE anon + security linter

Phase 2 — invite-only auth, 21st.dev shell
Phase 3 — screens
Phase 4 — read API (/api/public/v1/items)
Phase 5 — Apify collection, normalization, LogoriOn

Blocked on user
- GitHub connection
- APIFY_API_TOKEN added in Supabase dashboard
