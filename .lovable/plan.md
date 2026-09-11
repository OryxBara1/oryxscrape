# OryxScrape — Foundation Plan

## 1. Current state (verified)

- Supabase connection: **active**. The app points at `nlthswnojvkqpooztans` (eu-central-1, OryxBara), and a live query succeeded. No new Supabase project will be created.
- Database content: `public` schema is **completely empty** — zero tables, functions, triggers, storage buckets. Only Supabase's own `auth` and `storage` internals exist. Clean slate.
- Codebase: untouched TanStack Start scaffold. One placeholder home page, root layout, Supabase client/auth helpers already generated, full default shadcn component set present in `src/components/ui`, Tailwind v4 via `src/styles.css`.
- GitHub: not connected yet — must be done by you through the chat "+" menu (I cannot connect it).

## 2. Proposed structure

```text
src/
  routes/
    index.tsx                  redirect -> /dashboard
    _authenticated/
      route.tsx                sign-in gate (managed)
      dashboard.tsx            screen 1
      sources.tsx              screen 2
      jobs.tsx                 screen 3
      items.tsx                screen 4
      audit.tsx                screen 5
    auth.tsx                   internal staff sign-in
    api/public/
      v1.items.ts              read-only consumer API (key-authenticated)
  components/
    shell/                     sidebar shell, topbar
    registry/                  21st.dev installed components
    features/                  screen-specific composites
  lib/
    sources.functions.ts       server functions per domain
    jobs.functions.ts
    items.functions.ts
    audit.functions.ts
    keys.functions.ts
    tiers.ts                   tier hierarchy constants
```

## 3. Schema proposal (described, SQL comes later, one migration at a time)

Every table: RLS enabled, explicit grants, `created_at`/`updated_at` with trigger. No table readable by `anon`. Consumer apps never touch tables directly — only the read API surface.

- **sources** — target name, base URL, domain, collection method (apify / http / api / manual), robots.txt status, ToS status + reviewed date, reliability tier, active flag, notes.
- **source_tiers** (reference table, seeded first) — tier code, rank, label, description, whether it may feed production. Decided before any job runs.
- **collection_jobs** — source reference, status (queued/running/succeeded/failed/cancelled), started/finished timestamps, item counts (fetched, new, duplicate, failed), error text, run parameters, external run id.
- **raw_items** — immutable: job reference, source reference, source URL, raw payload (jsonb), content hash (unique per source, gives duplicate detection), collected_at, collection method. No updates or deletes allowed by policy.
- **normalized_items** — one row per raw item, generic shape: title, summary, body, canonical URL, language, media (jsonb), attributes (jsonb, domain-agnostic), consumer tags (array: auramaris / fortiora / vellum / plantech), tier inherited from source, review status, published flag.
- **consumer_keys** — consumer app name, hashed key (never plaintext), allowed tags, allowed tiers, active flag, last used, revoked date. Read scope only.
- **audit_events** — check type (duplicate / consistency / tier drift / ToS recheck), target reference, result, findings jsonb, run timestamp.

Access model: internal staff (authenticated users) read/write via the app; the public read API validates a hashed consumer key server-side and returns only published, tag-and-tier-permitted normalized items. Raw payloads never leave the service.

## 4. 21st.dev component mapping

| Component | Screen | Conflict check |
|---|---|---|
| dashboard-sidebar | Shell for all 5 screens | Replaces default `sidebar.tsx`; the default file stays on disk but is not imported |
| glowing-card | Dashboard metric cards (4 metrics) | Replaces `card.tsx` usage |
| glare-cards | Dashboard alerts (failed jobs, ToS expiring), Audit highlights | None |
| animated-status-badge | Job status in jobs list and items table | Replaces `badge.tsx` usage |
| hud-status-1 | Live job monitor header on Collection jobs | None |
| v-table-3 | Collected items browser, also Sources list | Replaces `table.tsx` usage |
| glow-button | All actions (run job, add source, revoke key) | Replaces `button.tsx` usage |
| v-skeleton-8 | Loading state on every data screen | Replaces `skeleton.tsx` usage |

Flags to be aware of:
- 21st.dev components are installed with the shadcn CLI and frequently depend on default shadcn primitives internally (button, card, utils). Those internal dependencies stay; the rule I will enforce is that **no screen imports a default primitive directly** — every visible surface is a registry component.
- Some registry components ship animation libs (framer-motion / motion) and their own CSS variables; they will be added as dependencies and their tokens folded into `src/styles.css`.
- Registry installs need network access at build time. If any of the eight URLs fails to resolve, I will stop and report it rather than substitute a default component.
- Forms, dialogs, selects and filter inputs are not covered by the eight components; unless you say otherwise I will style those minimally from the existing primitives, since no registry equivalent was specified.

## 5. Build roadmap (small, isolated, testable)

Phase 0 — governance
1. You connect GitHub. You confirm the tier hierarchy (see open questions).

Phase 1 — schema (one migration per step, no UI in the same step)
2. Migration A: enums, `source_tiers` + seeded tiers, timestamp trigger.
3. Migration B: `sources`.
4. Migration C: `collection_jobs`.
5. Migration D: `raw_items` (append-only policies, content-hash uniqueness).
6. Migration E: `normalized_items`.
7. Migration F: `consumer_keys` + `audit_events`.
8. Security lint pass on all of the above.

Phase 2 — shell
9. Install the 8 registry components, set dark glass/glow theme tokens.
10. Build sidebar shell + auth gate + empty routed screens.

Phase 3 — screens (one per step, each with its own server functions)
11. Dashboard home. 12. Sources. 13. Collection jobs. 14. Collected items browser. 15. Audit log.

Phase 4 — API surface
16. Read-only consumer API with hashed key auth + tag/tier scoping, plus key management UI.

Phase 5 — collection integration (last)
17. Apify/collector integration writing into raw_items only, then normalization step.

Nothing in Phase 5 can write to `normalized_items` without a `raw_items` row.

## 6. Open questions (needed before the first build)

1. **Tier hierarchy** — what are the exact tiers and their names/ranks? (e.g. T1 official/primary source, T2 institutional, T3 reputable secondary, T4 aggregated, T5 unverified.) Which tiers may reach production consumers?
2. **Who signs in?** Internal staff via email/password, Google, or a fixed allow-list of OryxBara accounts?
3. **"LogoriOn"** in your roadmap item 5 — I don't know this system. What is it and what does the integration do (is it the collector/Apify orchestrator, or something else)?
4. **Apify** — is Apify the collection engine for v1, and do you already have an Apify token to store?
5. **Consumer key delivery** — is Auramaris pulling over HTTPS with a bearer key, and does it need pagination + incremental sync (`updated_since`) from day one?
6. **Normalized attributes** — any fields Auramaris needs immediately beyond title/summary/body/url/media/tags, or is the generic jsonb enough for v1?
