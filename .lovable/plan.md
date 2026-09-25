# `collect-sources` dispatcher

You asked for a Supabase Edge Function. This project cannot deploy new Edge Functions — the platform blocks creating them here (confirmed again earlier when I tried), and there is no `supabase/functions/` folder: all scheduled collection already runs as protected endpoints inside the app itself. So the plan is to build the exact same dispatcher, with the same request body and the same JSON response, as an in-app endpoint.

## What gets built

One new file: `src/routes/api/public/cron/collect-sources.ts`

- Address: `POST https://oryxscrape.lovable.app/api/public/cron/collect-sources`
- Body: `{"scope":"single","source_domain":"officielebekendmakingen.nl"}` or `{"scope":"all"}` (empty body = all)
- Returns the same `{ summary, results }` shape as your code, including per-source timing, usage, character count and insert status.

Behaviour, matching your source line for line:
- Reads active sources (optionally one domain), fetches each start page through Parallel Extract, stores a job row, then an immutable raw item with its SHA-256 hash and `parallel_extract` method.
- Six sources at a time, failures reported per source instead of stopping the batch.
- Nothing is reviewed, published or promoted; every item stays unreviewed and internal-only.

## Three differences from the pasted code, and why

1. **Authentication.** The other scheduled endpoints all use the shared cron secret (`Authorization: Bearer <LOVABLE_CRON_SECRET>`), not a Supabase key. This one will use the same, so your scheduler keeps one credential for every job. Anonymous callers get 401.
2. **Database access.** Instead of hand-written REST calls with the service key, it uses the app's existing admin client — same privileges, same tables, already wired and tested.
3. **Parallel calls go through the Lovable connector gateway**, which is how this project is allowed to reach Parallel. Same endpoint and same request body.

## One thing to decide

Your code skips any source that already has a single raw item ever collected. Sixteen of the eighteen active sources already have items, so `{"scope":"all"}` would process only the two that never collected anything, and after one run it would do nothing at all forever.

Options:
- **A — keep as written.** A first-collection backfill tool: useful once, then idle.
- **B — no skip.** Every run re-extracts every active source; the hash check still prevents duplicate storage.
- **C — skip only recent.** Skip a source that already collected within the last 7 days; everything else runs.

I'll implement A exactly as your code says unless you pick another.

## Not touched

No schema changes, no other files, no existing endpoints or collectors altered, no review state modified.
