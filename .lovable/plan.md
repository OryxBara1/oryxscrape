# Consumer sync: architecture review and recommendation

## Current state (verified)

1. **Webhook column:** `consumer_keys` has no `webhook_url` / `notify_url`. It has `consumer_app`, `profile_id`, `allowed_tags`, `is_active`, `last_used_at`, `revoked_at`. OryxScrape cannot push anything to consumers today.
2. **Stats endpoint:** none exists. The only consumer endpoints are `/api/public/feed` and the older `/api/public/v1/items`.
3. **`since` on the feed:** already supported. `?since=<ISO>` filters `updated_at > since`. Because `set_normalized_items_updated_at` bumps `updated_at` on every update, an item moving to `eligible` gets a fresh timestamp, so `since` catches newly published items as well as edits.

### Gap in the existing `since`
The feed sorts `updated_at DESC` and pages with `offset`. That is fine for browsing but unsafe for incremental sync: if items change while a consumer pages through, rows shift between pages and some get skipped. A consumer also cannot tell a new item from an edited one, and it never learns about items that were withdrawn (moved back to `internal_only` or rejected).

The main bug you found is on the AuraMaris side (its sync only updates existing rows and never inserts). No OryxScrape change fixes that. AuraMaris needs to upsert by `id`.

## Recommendation

Make pull reliable first. Add push later, and only as a wake-up signal.

**Phase 1 (do now): stable incremental pull on `/api/public/feed`**
- Add `order=asc` (the default for incremental use) plus a keyset cursor: `next_cursor` = (updated_at, id). The same pattern already works in `/v1/items`.
- Return `next_since` = the last item's `updated_at` so the consumer can store its checkpoint.
- Keep `offset` and `DESC` for backward compatibility.
- Consumer loop: store `next_since` → call `?since=X&order=asc` every N minutes → upsert by `id` → repeat while `has_more`.

**Phase 2 (do now, small): cheap change detection**
- `GET /api/public/feed/stats` (same auth, same profile scoping): `{ total_eligible, last_updated_at }`.
- The consumer polls this every few minutes and fetches the feed only when `last_updated_at` is newer than its checkpoint. This answers question 2, and it should respect the key's scope rather than being fully public.

**Phase 3 (optional, later): webhook notification**
- Add `notify_url` and a `notify_secret` per consumer key (the secret signs the payload with HMAC; it is never returned by the API).
- Trigger it with a Supabase Database Webhook on `normalized_items` updates to `eligible`, which calls an internal server route. The route debounces and batches (for example, at most one notification per consumer per 5 minutes) and POSTs `{ event: "new_items", count, since }`, signed.
- The payload carries no document data. The consumer still pulls through the feed, so a missed webhook costs only latency, never data.
- Reason to defer: it adds retry, signing and delivery tracking for a single consumer, and Phase 1+2 polling already gives delivery within minutes.

## Answers to your questions
1. There is no webhook column. It is worth adding later (Phase 3) as a signed, data-free ping, not as the main sync mechanism.
2. Yes, but scoped to the key, not public. It is the cheapest win.
3. `since` already exists. It needs ascending order and a cursor to be safe for incremental sync.

## Out of scope for OryxScrape
- Fixing AuraMaris's sync to insert new items (upsert by `id`) and to schedule it instead of relying on a button click.
- Tombstones for withdrawn items: I suggest a follow-up that adds `?include_withdrawn=true`, returning `{ id, withdrawn: true }`.

## Technical notes
- Files: `src/routes/api/public/feed.ts` (order/cursor/next_since) and a new `src/routes/api/public/feed.stats.ts`. The cursor helpers already exist in `consumer-keys.server.ts`.
- Phase 3 needs a migration that adds nullable columns to `consumer_keys`, plus a route under `/api/public/hooks/`.
